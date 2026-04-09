const express = require('express');
const router = express.Router();
const { getDb, dbGet, dbAll, dbRun, persistDb, isPg, isMysql } = require('../database/db');
const { verifyToken } = require('../middleware/auth');

// ─── GET /api/balance ─────────────────────────────────────────
router.get('/balance', verifyToken, async (req, res) => {
    try {
        const db = await getDb();
        const user = await dbGet(db, 'SELECT id, username, phone, balance, account_number FROM users WHERE id = ?', [req.user.id]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        return res.status(200).json({
            success: true,
            balance: parseFloat(user.balance),
            username: user.username,
            phone: user.phone,
            accountNumber: user.account_number
        });
    } catch (error) {
        console.error('Balance error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ─── POST /api/deposit ────────────────────────────────────────
router.post('/deposit', verifyToken, async (req, res) => {
    try {
        const { amount } = req.body;
        const userId = req.user.id;

        if (!amount) return res.status(400).json({ success: false, message: 'Amount is required.' });
        const depositAmount = parseFloat(amount);
        if (isNaN(depositAmount) || depositAmount <= 0)
            return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
        if (depositAmount > 10000000)
            return res.status(400).json({ success: false, message: 'Maximum single deposit is ₹1,00,00,000 (1 Crore).' });
        if (depositAmount < 1)
            return res.status(400).json({ success: false, message: 'Minimum deposit amount is ₹1.' });

        const db = await getDb();
        const user = await dbGet(db, 'SELECT * FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        if (isMysql) {
            const client = await db.getConnection();
            try {
                await client.beginTransaction();
                await client.query('UPDATE users SET balance = balance + ? WHERE id = ?', [depositAmount, userId]);
                await client.query(
                    'INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES (?, ?, ?, ?)',
                    [userId, userId, depositAmount, 'deposit']
                );
                await client.commit();
            } catch (e) { await client.rollback(); throw e; }
            finally { client.release(); }
        } else if (isPg) {
            const client = await db.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [depositAmount, userId]);
                await client.query(
                    'INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES ($1, $2, $3, $4)',
                    [userId, userId, depositAmount, 'deposit']
                );
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        } else {
            db.run('BEGIN TRANSACTION');
            db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [depositAmount, userId]);
            db.run('INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES (?, ?, ?, ?)',
                [userId, userId, depositAmount, 'deposit']);
            db.run('COMMIT');
        }
        persistDb(db);

        const updated = await dbGet(db, 'SELECT balance FROM users WHERE id = ?', [userId]);
        const newBalance = parseFloat(updated.balance);

        return res.status(200).json({
            success: true,
            message: `₹${depositAmount.toFixed(2)} added to your account successfully!`,
            newBalance
        });
    } catch (error) {
        console.error('Deposit error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error during deposit.' });
    }
});

// ─── POST /api/transfer ───────────────────────────────────────
router.post('/transfer', verifyToken, async (req, res) => {
    try {
        const { receiverPhone, amount } = req.body;
        const senderId = req.user.id;

        if (!receiverPhone || !amount)
            return res.status(400).json({ success: false, message: 'Receiver phone and amount are required.' });
        const transferAmount = parseFloat(amount);
        if (isNaN(transferAmount) || transferAmount <= 0)
            return res.status(400).json({ success: false, message: 'Amount must be a positive number.' });
        if (transferAmount < 1)
            return res.status(400).json({ success: false, message: 'Minimum transfer amount is ₹1.' });
        if (transferAmount > 1000000)
            return res.status(400).json({ success: false, message: 'Transfer limit exceeded. Maximum is ₹10,00,000.' });
        if (!/^\d{10}$/.test(String(receiverPhone).trim()))
            return res.status(400).json({ success: false, message: 'Receiver phone must be exactly 10 digits.' });

        const db = await getDb();
        const sender = await dbGet(db, 'SELECT * FROM users WHERE id = ?', [senderId]);
        if (!sender) return res.status(404).json({ success: false, message: 'Sender account not found.' });
        if (sender.phone === String(receiverPhone).trim())
            return res.status(400).json({ success: false, message: 'You cannot transfer money to yourself.' });

        const receiver = await dbGet(db, 'SELECT * FROM users WHERE phone = ?', [String(receiverPhone).trim()]);
        if (!receiver)
            return res.status(404).json({ success: false, message: 'Receiver account not found. Please check the phone number.' });

        if (parseFloat(sender.balance) < transferAmount)
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. Your current balance is ₹${parseFloat(sender.balance).toFixed(2)}.`
            });

        if (isMysql) {
            const client = await db.getConnection();
            try {
                await client.beginTransaction();
                await client.query('UPDATE users SET balance = balance - ? WHERE id = ?', [transferAmount, senderId]);
                await client.query('UPDATE users SET balance = balance + ? WHERE id = ?', [transferAmount, receiver.id]);
                await client.query(
                    'INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES (?, ?, ?, ?)',
                    [senderId, receiver.id, transferAmount, 'transfer']
                );
                await client.commit();
            } catch (e) { await client.rollback(); throw e; }
            finally { client.release(); }
        } else if (isPg) {
            const client = await db.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [transferAmount, senderId]);
                await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [transferAmount, receiver.id]);
                await client.query(
                    'INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES ($1, $2, $3, $4)',
                    [senderId, receiver.id, transferAmount, 'transfer']
                );
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; }
            finally { client.release(); }
        } else {
            db.run('BEGIN TRANSACTION');
            db.run('UPDATE users SET balance = balance - ? WHERE id = ?', [transferAmount, senderId]);
            db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [transferAmount, receiver.id]);
            db.run('INSERT INTO transactions (sender_id, receiver_id, amount, type) VALUES (?, ?, ?, ?)',
                [senderId, receiver.id, transferAmount, 'transfer']);
            db.run('COMMIT');
        }
        persistDb(db);

        const updatedSender = await dbGet(db, 'SELECT balance FROM users WHERE id = ?', [senderId]);
        return res.status(200).json({
            success: true,
            message: `₹${transferAmount.toFixed(2)} sent to ${receiver.username} successfully!`,
            newBalance: parseFloat(updatedSender.balance),
            receiverName: receiver.username
        });
    } catch (error) {
        console.error('Transfer error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error during transfer.' });
    }
});

// ─── GET /api/transactions ────────────────────────────────────
router.get('/transactions', verifyToken, async (req, res) => {
    try {
        const db = await getDb();
        const userId = parseInt(req.user.id, 10);

        const sql = `
          SELECT
            t.id,
            CAST(t.amount AS REAL) AS amount,
            t.timestamp,
            t.type,
            CASE
              WHEN t.type = 'deposit'      THEN 'deposit'
              WHEN t.sender_id = ? THEN 'debit'
              ELSE                              'credit'
            END AS direction,
            CASE
              WHEN t.type = 'deposit'      THEN u_self.username
              WHEN t.sender_id = ? THEN r.username
              ELSE                              s.username
            END AS party_name,
            CASE
              WHEN t.type = 'deposit'      THEN u_self.phone
              WHEN t.sender_id = ? THEN r.phone
              ELSE                              s.phone
            END AS party_phone
          FROM transactions t
          JOIN users s      ON s.id = t.sender_id
          JOIN users r      ON r.id = t.receiver_id
          JOIN users u_self ON u_self.id = ?
          WHERE (t.sender_id = ? OR t.receiver_id = ?)
          ORDER BY t.timestamp DESC
          LIMIT 30
        `;

        const rows = await dbAll(db, sql, [userId, userId, userId, userId, userId, userId]);
        return res.status(200).json({ success: true, transactions: rows });
    } catch (error) {
        console.error('Transactions error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

// ─── GET /api/user ────────────────────────────────────────────
router.get('/user', verifyToken, async (req, res) => {
    try {
        const db = await getDb();
        const user = await dbGet(
            db,
            'SELECT id, username, phone, CAST(balance AS REAL) AS balance, account_number, created_at FROM users WHERE id = ?',
            [req.user.id]
        );
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
        const payload = { ...user, accountNumber: user.account_number };
        delete payload.account_number;
        return res.status(200).json({ success: true, user: payload });
    } catch (error) {
        console.error('User error:', error.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});

module.exports = router;

