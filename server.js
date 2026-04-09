require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./src/routes/auth');
const bankRoutes = require('./src/routes/bank');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ───────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
        }
    }
}));

// ─── Rate Limiting ─────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,  // 10-minute window
    max: 15,                    // 15 attempts per window (generous for dev, protective for prod)
    statusCode: 429,
    standardHeaders: true,      // sends Retry-After header
    legacyHeaders: false,
    message: {
        success: false,
        code: 'too_many_attempts',
        message: 'Too many attempts detected. Please wait a few minutes and try again.'
    }
});

app.use(generalLimiter);
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// ─── CORS ──────────────────────────────────────────────────────────────────
const allowedOrigins = [
    'http://localhost:3000',
    'https://bank-app-sandy-pi.vercel.app'
];
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps)
        if (!origin) return callback(null, true);

        // Allow localhost and specific production domain
        const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1');
        const isVercel = origin.endsWith('.vercel.app');

        if (isLocal || isVercel || process.env.VERCEL) {
            return callback(null, true);
        }
        callback(new Error('CORS: Origin not allowed'));
    },
    credentials: true
}));


// ─── Body Parsing ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(cookieParser());

// ─── Static Files (Frontend) ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

// ─── API Routes ────────────────────────────────────────────────────────────
app.use('/api', authRoutes);
app.use('/api', bankRoutes);
app.use('/api', require('./src/routes/chat'));

// ─── Health check for debugging ─────────────────────────────
app.get('/api/health', async (req, res) => {
    const envData = {
        NODE_ENV: process.env.NODE_ENV,
        VERCEL: !!process.env.VERCEL,
        HAS_DB_URL: !!process.env.DATABASE_URL,
        HAS_JWT: !!process.env.JWT_SECRET,
        PORT: process.env.PORT,
        HAS_HF_KEY: !!process.env.HF_API_KEY,
        PROJECT: process.env.VERCEL_PROJECT_NAME,
        ID: process.env.VERCEL_DEPLOYMENT_ID
    };

    try {
        const { getDb, dbGet, isPg, isMysql } = require('./src/database/db');

        // If we don't have a DB URL and we are on Vercel, we know it will likely fail 
        // because of sql.js WASM issues. Let's catch that specifically.
        if (!!process.env.VERCEL && !process.env.DATABASE_URL) {
            // Log keys of environment variables for debugging (NOT the values)
            console.warn('Available Env Keys:', Object.keys(process.env).join(', '));
            return res.json({
                status: 'warning',
                message: 'Running on Vercel without DATABASE_URL. SQLite fallback will likely fail due to WASM constraints.',
                env: envData,
                availableKeys: Object.keys(process.env).filter(k => !k.includes('SECRET') && !k.includes('KEY') && !k.includes('PASSWORD') && !k.includes('URL'))
            });
        }

        const db = await getDb();
        const result = await dbGet(db, 'SELECT 1 as connected');
        res.json({
            status: 'ok',
            database: isMysql ? 'MySQL' : (isPg ? 'PostgreSQL' : 'SQLite'),
            connected: !!result,
            env: envData
        });
    } catch (err) {
        res.status(500).json({
            status: 'error',
            message: err.message,
            env: envData,
            tip: !process.env.DATABASE_URL ? 'Please add DATABASE_URL to your Vercel Environment Variables.' : 'Check your database credentials.'
        });
    }
});

// ─── SPA Fallback (serve index.html for all non-API routes) ───────────────
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).json({ success: false, message: 'API endpoint not found.' });
    }
});

// ─── Global Error Handler ──────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    // Be more descriptive if not in strict production or if it's a known error type
    const message = (process.env.NODE_ENV !== 'production' || err.expose)
        ? err.message
        : 'An unexpected error occurred.';

    res.status(err.status || 500).json({
        success: false,
        message: message,
        error: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    });
});

// ─── Start Server (local dev only — Vercel handles this in production) ────
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`\n🏦 State Bank of Karnataka — API Server running on http://localhost:${PORT}`);
        console.log(`📊 Dashboard: http://localhost:${PORT}`);
        console.log(`🔐 Environment: ${process.env.NODE_ENV || 'development'}\n`);
    });
}

// Export for Vercel serverless
module.exports = app;
