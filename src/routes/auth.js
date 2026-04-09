const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb, dbRun, dbGet, persistDb, generateAccountNumber, isPg, isMysql } = require('../database/db');
const { generateToken } = require('../middleware/auth');

// ─── POST /api/register ──────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { username, phone, password, confirmPassword } = req.body;

        // Validation
        if (!username || !phone || !password || !confirmPassword)
            return res.status(400).json({ success: false, message: 'All fields are required.' });
        if (username.trim().length < 2)
            return res.status(400).json({ success: false, message: 'Full name must be at least 2 characters.' });
        if (!/^\d{10}$/.test(phone.trim()))
            return res.status(400).json({ success: false, message: 'Phone number must be exactly 10 digits.' });
        if (password.length < 6)
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
        if (password !== confirmPassword)
            return res.status(400).json({ success: false, message: 'Passwords do not match.' });

        const db = await getDb();

        // Phone uniqueness check
        const existing = await dbGet(db, 'SELECT id FROM users WHERE phone = ?', [phone.trim()]);
        if (existing)
            return res.status(409).json({ success: false, message: 'This phone number is already registered. Please login.' });

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Generate unique account number
        const accountNumber = await generateAccountNumber(db);

        let userId;

        if (isMysql) {
            const [result] = await db.query(
                'INSERT INTO users (username, phone, password, balance, account_number) VALUES (?, ?, ?, ?, ?)',
                [username.trim(), phone.trim(), hashedPassword, 0.0, accountNumber]
            );
            userId = result.insertId;
        } else if (isPg) {
            // PostgreSQL: use RETURNING id
            const result = await db.query(
                'INSERT INTO users (username, phone, password, balance, account_number) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [username.trim(), phone.trim(), hashedPassword, 0.0, accountNumber]
            );
            userId = result.rows[0].id;
        } else {
            // SQLite
            const result = await dbRun(db,
                'INSERT INTO users (username, phone, password, balance, account_number) VALUES (?, ?, ?, ?, ?)',
                [username.trim(), phone.trim(), hashedPassword, 0.0, accountNumber]
            );
            userId = result.lastID;
        }

        if (!userId) {
            throw new Error('Failed to retrieve new user ID');
        }

        // Generate JWT
        const token = generateToken({ id: userId, phone: phone.trim(), username: username.trim() });
        await dbRun(db, 'UPDATE users SET jwt_token = ? WHERE id = ?', [token, userId]);
        persistDb(db);

        return res.status(201).json({
            success: true,
            message: `Account created! Welcome, ${username.trim()}. You can now login with your phone number.`,
            user: { id: userId, username: username.trim(), phone: phone.trim(), accountNumber }
        });

    } catch (error) {
        console.error('❌ Registration Exception:', error.name, error.message);
        console.error(error.stack);
        return res.status(500).json({
            success: false,
            message: 'Registration failed. Please try again.',
            error: process.env.NODE_ENV !== 'production' ? error.message : undefined
        });
    }
});

// ─── POST /api/login ─────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        if (!phone || !password)
            return res.status(400).json({ success: false, message: 'Phone number and password are required.' });
        if (!/^\d{10}$/.test(phone.trim()))
            return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit phone number.' });

        const db = await getDb();
        const user = await dbGet(db, 'SELECT * FROM users WHERE phone = ?', [phone.trim()]);

        if (!user)
            return res.status(401).json({ success: false, message: 'Invalid phone number or password. Please try again.' });

        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid)
            return res.status(401).json({ success: false, message: 'Invalid phone number or password. Please try again.' });

        const token = generateToken({ id: user.id, phone: user.phone, username: user.username });
        await dbRun(db, 'UPDATE users SET jwt_token = ? WHERE id = ?', [token, user.id]);
        persistDb(db);

        res.cookie('authToken', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 60 * 60 * 1000
        });

        return res.status(200).json({
            success: true,
            message: `Welcome back, ${user.username}!`,
            token,
            user: { id: user.id, username: user.username, phone: user.phone, accountNumber: user.account_number }
        });

    } catch (error) {
        console.error('❌ Login Exception:', error.name, error.message);
        console.error(error.stack);
        return res.status(500).json({
            success: false,
            message: 'Login failed. Please try again.',
            error: process.env.NODE_ENV !== 'production' ? error.message : undefined
        });
    }
});

// ─── POST /api/logout ────────────────────────────────────────
router.post('/logout', (req, res) => {
    res.clearCookie('authToken');
    return res.status(200).json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;

