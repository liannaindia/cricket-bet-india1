const express = require('express');
const fetch = require('node-fetch');
const session = require('express-session');
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const { MongoClient } = require('mongodb');
const path = require('path');

const app = express();

app.use(express.json());
app.use(express.static('public'));
app.use(morgan('combined'));
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// MongoDB 配置
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/cricket-bet-india';
const client = new MongoClient(MONGO_URI, {
    tls: true,
    tlsAllowInvalidCertificates: false,
    serverSelectionTimeoutMS: 5000
});
let db;
let isMongoConnected = false;

const collections = {
    users: 'users',
    bets: 'bets',
    deposits: 'deposits',
    withdrawals: 'withdrawals',
    depositInfo: 'depositInfo',
    matchOdds: 'matchOdds'
};

async function connectToMongo() {
    try {
        await client.connect();
        db = client.db('cricket-bet-india');
        isMongoConnected = true;
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        isMongoConnected = false;
    }
}

async function initCollections() {
    if (!isMongoConnected || !db) {
        console.error('MongoDB is not connected, skipping collection initialization');
        return;
    }
    const initialData = {
        users: [],
        bets: [],
        deposits: [],
        withdrawals: [],
        depositInfo: { upi: '', bank: { name: '', ac: '', ifsc: '' }, crypto: '' },
        matchOdds: {}
    };
    for (let [key, collectionName] of Object.entries(collections)) {
        const collection = db.collection(collectionName);
        const count = await collection.countDocuments();
        if (count === 0) {
            if (key === 'depositInfo') {
                await collection.insertOne(initialData[key]);
                console.log(`Initialized ${collectionName} with default data`);
            } else if (key === 'matchOdds') {
                await collection.insertOne({ odds: initialData[key] });
                console.log(`Initialized ${collectionName} with default data`);
            } else {
                if (initialData[key].length > 0) {
                    await collection.insertMany(initialData[key]);
                    console.log(`Initialized ${collectionName} with ${initialData[key].length} documents`);
                } else {
                    console.log(`Skipped initializing ${collectionName} as initial data is empty`);
                }
            }
        } else {
            console.log(`${collectionName} already has ${count} documents, skipping initialization`);
        }
    }
}

// 检查 MongoDB 连接状态的中间件
const checkMongoConnection = (req, res, next) => {
    if (!isMongoConnected) {
        return res.status(503).json({ success: false, message: 'Service unavailable: MongoDB is not connected' });
    }
    next();
};

// CricketData.org API 配置
const CRICKETDATA_API_KEY = process.env.CRICKETDATA_API_KEY;
if (!CRICKETDATA_API_KEY) {
    console.error('CRICKETDATA_API_KEY is not set in environment variables. Please set it to a valid CricAPI key.');
    process.exit(1); // 退出程序，防止使用无效的 API 密钥
}

// 获取比赛数据
app.get('/matches', async (req, res) => {
    console.log('Matches route called at:', new Date().toISOString());
    try {
        let allMatches = [];
        const seriesResponse = await fetch(`https://api.cricapi.com/v1/series?apikey=${CRICKETDATA_API_KEY}`);
        const seriesData = await seriesResponse.json();
        console.log('Series data:', seriesData);
        if (seriesData && seriesData.data) {
            for (const series of seriesData.data) {
                const seriesId = series.id;
                const seriesMatchesResponse = await fetch(`https://api.cricapi.com/v1/series_info?apikey=${CRICKETDATA_API_KEY}&id=${seriesId}`);
                const seriesMatchesData = await seriesMatchesResponse.json();
                console.log(`Series matches data for series ${seriesId}:`, seriesMatchesData);
                if (seriesMatchesData && seriesMatchesData.data && seriesMatchesData.data.matchList) {
                    allMatches = allMatches.concat(seriesMatchesData.data.matchList);
                }
            }
        }
        console.log('Matches after series fetch:', allMatches.length);
        if (allMatches.length < 50) {
            const matchesPerPage = 25;
            const pagesToFetch = 5;
            for (let offset = 0; offset < pagesToFetch * matchesPerPage; offset += matchesPerPage) {
                const response = await fetch(`https://api.cricapi.com/v1/matches?apikey=${CRICKETDATA_API_KEY}&offset=${offset}`);
                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('application/json')) {
                    const text = await response.text();
                    console.error(`Non-JSON response received at offset ${offset}:`, text.slice(0, 100));
                    continue;
                }
                const apiData = await response.json();
                console.log(`Matches data at offset ${offset}:`, apiData);
                if (!apiData || !apiData.data) continue;
                allMatches = allMatches.concat(apiData.data);
            }
        }
        console.log('Total matches fetched:', allMatches.length);
        if (allMatches.length === 0) {
            return res.status(200).json({ success: true, message: 'No matches available from API', data: [] });
        }
        const matchOddsDoc = isMongoConnected ? await db.collection(collections.matchOdds).findOne() : { odds: {} };
        const matchOdds = matchOddsDoc ? matchOddsDoc.odds : {};
        const matches = allMatches.map(match => {
            const now = new Date();
            const matchDate = new Date(match.dateTimeGMT);
            let status = 'upcoming';
            if (match.matchStarted) {
                status = match.matchEnded ? 'completed' : 'live';
            } else if (matchDate < now) {
                status = 'completed';
            }
            return {
                id: match.id,
                team1: match.teams[0] || 'TBD',
                team2: match.teams[1] || 'TBD',
                date: match.dateTimeGMT,
                status: status,
                odds: matchOdds[match.id] || { team1: 1.5, team2: 1.5 },
                matchType: match.matchType || 'unknown'
            };
        });
        matches.sort((a, b) => new Date(a.date) - new Date(b.date));
        res.json({ success: true, data: matches });
    } catch (error) {
        console.error('Error fetching matches:', error);
        res.status(500).json({ success: false, message: 'Error fetching matches', error: error.message });
    }
});

// 其他路由（需要 MongoDB 的路由使用 checkMongoConnection 中间件）
app.post('/register', checkMongoConnection, async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || phone.length !== 10 || !password || password.length < 6) return res.json({ success: false, message: 'Invalid input' });
    const usersCollection = db.collection(collections.users);
    const existingUser = await usersCollection.findOne({ phone });
    if (existingUser) return res.json({ success: false, message: 'Phone already registered' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = {
        id: Date.now().toString(),
        phone,
        password: hashedPassword,
        balance: 0,
        name: `User${Math.floor(Math.random() * 1000)}`,
        bankInfo: { name: '', ac: '', ifsc: '' },
        cryptoWallet: ''
    };
    await usersCollection.insertOne(user);
    res.json({ success: true, user });
});

app.post('/login', checkMongoConnection, async (req, res) => {
    const { phone, password } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ phone });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.json({ success: false, message: 'Invalid credentials' });
    req.session.userId = user.id;
    res.json({ success: true, user });
});

app.post('/profile', checkMongoConnection, async (req, res) => {
    const { userId, bankInfo, cryptoWallet } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ id: userId });
    if (!user) return res.json({ success: false, message: 'User not found' });
    if (bankInfo) user.bankInfo = bankInfo;
    if (cryptoWallet) user.cryptoWallet = cryptoWallet;
    await usersCollection.updateOne({ id: userId }, { $set: { bankInfo: user.bankInfo, cryptoWallet: user.cryptoWallet } });
    res.json({ success: true, user });
});

app.post('/bet', checkMongoConnection, async (req, res) => {
    const { userId, matchId, team, amount } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ id: userId });
    if (!user || user.balance < amount || amount < 20 || amount > 5000) return res.json({ success: false, message: 'Invalid bet' });
    await usersCollection.updateOne({ id: userId }, { $inc: { balance: -amount } });
    const betsCollection = db.collection(collections.bets);
    await betsCollection.insertOne({ id: Date.now().toString(), userId, matchId, team, amount, status: 'pending' });
    res.json({ success: true, balance: user.balance - amount });
});

app.get('/deposit-info', checkMongoConnection, async (req, res) => {
    const depositInfoCollection = db.collection(collections.depositInfo);
    const info = await depositInfoCollection.findOne();
    res.json(info);
});

app.post('/deposit', checkMongoConnection, async (req, res) => {
    const { userId, amount, method, transactionId, cryptoAddress } = req.body;
    if (amount < 50 || amount > 20000) return res.json({ success: false, message: 'Invalid amount' });
    const depositsCollection = db.collection(collections.deposits);
    await depositsCollection.insertOne({ id: Date.now().toString(), userId, amount, method, transactionId, cryptoAddress, status: 'pending' });
    res.json({ success: true });
});

app.post('/withdraw', checkMongoConnection, async (req, res) => {
    if (!req.session.userId || req.session.userId !== req.body.userId) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const { userId, amount, method } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ id: userId });
    if (!user || user.balance < amount || amount < 100 || amount > 50000) return res.json({ success: false, message: 'Invalid withdrawal' });
    const withdrawalsCollection = db.collection(collections.withdrawals);
    await withdrawalsCollection.insertOne({ id: Date.now().toString(), userId, amount, method, status: 'pending' });
    res.json({ success: true });
});

app.get('/admin', (req, res) => {
    if (!req.session.isAdmin) {
        return res.redirect('/admin-login');
    }
    res.sendFile(path.join(__dirname, 'public/admin.html'));
});

app.get('/admin-login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/admin-login.html'));
});

app.post('/admin-login', (req, res) => {
    const { username, password } = req.body;
    const ADMIN_USERNAME = 'admin'; // 替换为你的管理员用户名
    const ADMIN_PASSWORD = '123456'; // 替换为你的管理员密码
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return res.json({ success: true, redirect: '/admin' });
    }
    res.status(401).json({ success: false, message: '用户名或密码错误' });
});

app.post('/admin-logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, redirect: '/admin-login' });
});

app.get('/admin/users', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const usersCollection = db.collection(collections.users);
    const users = await usersCollection.find().toArray();
    res.json(users);
});

app.delete('/admin/users/:phone', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const usersCollection = db.collection(collections.users);
    await usersCollection.deleteOne({ phone: req.params.phone });
    res.json({ success: true });
});

app.get('/admin/deposits', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const depositsCollection = db.collection(collections.deposits);
    const deposits = await depositsCollection.find().toArray();
    res.json(deposits);
});

app.post('/admin/deposits/:id', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { action } = req.body;
    const depositsCollection = db.collection(collections.deposits);
    const deposit = await depositsCollection.findOne({ id: req.params.id });
    if (action === 'approve') {
        const usersCollection = db.collection(collections.users);
        await usersCollection.updateOne({ id: deposit.userId }, { $inc: { balance: parseInt(deposit.amount) } });
    }
    await depositsCollection.updateOne({ id: req.params.id }, { $set: { status: action === 'approve' ? 'approved' : 'rejected' } });
    res.json({ success: true });
});

app.get('/admin/withdrawals', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const withdrawalsCollection = db.collection(collections.withdrawals);
    const withdrawals = await withdrawalsCollection.find().toArray();
    res.json(withdrawals);
});

app.post('/admin/withdrawals/:id', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { action } = req.body;
    const withdrawalsCollection = db.collection(collections.withdrawals);
    const withdrawal = await withdrawalsCollection.findOne({ id: req.params.id });
    if (action === 'approve') {
        const usersCollection = db.collection(collections.users);
        await usersCollection.updateOne({ id: withdrawal.userId }, { $inc: { balance: -parseInt(withdrawal.amount) } });
    }
    await withdrawalsCollection.updateOne({ id: req.params.id }, { $set: { status: action === 'approve' ? 'approved' : 'rejected' } });
    res.json({ success: true });
});

app.post('/admin/matches/:id/odds', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { team1Odds, team2Odds } = req.body;
    const matchOddsCollection = db.collection(collections.matchOdds);
    await matchOddsCollection.updateOne({}, { $set: { [`odds.${req.params.id}`]: { team1: parseFloat(team1Odds), team2: parseFloat(team2Odds) } } }, { upsert: true });
    res.json({ success: true });
});

app.post('/admin/matches/:id/result', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { winner } = req.body;
    const betsCollection = db.collection(collections.bets);
    const usersCollection = db.collection(collections.users);
    const matchOddsCollection = db.collection(collections.matchOdds);
    const matchOddsDoc = await matchOddsCollection.findOne();
    const matchOdds = matchOddsDoc ? matchOddsDoc.odds : {};

    try {
        const response = await fetch(`https://api.cricapi.com/v1/matches/${req.params.id}?apikey=${CRICKETDATA_API_KEY}`);
        const matchData = await response.json();
        const team1 = matchData.data?.teams?.[0] || 'TBD';
        const team2 = matchData.data?.teams?.[1] || 'TBD';

        const match = { id: req.params.id, odds: matchOdds[req.params.id] || { team1: 1.5, team2: 1.5 } };
        const bets = await betsCollection.find({ matchId: match.id }).toArray();
        for (const bet of bets) {
            if (bet.team === (winner === 'team1' ? team1 : team2)) {
                await betsCollection.updateOne({ id: bet.id }, { $set: { status: 'won' } });
                await usersCollection.updateOne({ id: bet.userId }, { $inc: { balance: bet.amount * match.odds[winner] } });
            } else {
                await betsCollection.updateOne({ id: bet.id }, { $set: { status: 'lost' } });
            }
        }
    } catch (error) {
        console.error('Error fetching match details:', error);
        return res.status(500).json({ success: false, message: 'Error fetching match details' });
    }
    res.json({ success: true });
});

app.post('/admin/deposit-info', checkMongoConnection, async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { upi, bank, crypto } = req.body;
    const depositInfoCollection = db.collection(collections.depositInfo);
    const update = {};
    if (upi) update.upi = upi;
    if (bank) update.bank = bank;
    if (crypto) update.crypto = crypto;
    await depositInfoCollection.updateOne({}, { $set: update }, { upsert: true });
    res.json({ success: true });
});

// 启动服务器
connectToMongo().then(() => {
    initCollections().then(() => {
        const port = process.env.PORT || 3000;
        app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
    }).catch(err => {
        console.error('Error initializing collections:', err);
        const port = process.env.PORT || 3000;
        app.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port} (MongoDB not connected)`));
    });
});
