const express = require('express');
const fetch = require('node-fetch');
const session = require('express-session');
const bcrypt = require('bcrypt');
const morgan = require('morgan');
const { MongoClient } = require('mongodb');

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
const client = new MongoClient(MONGO_URI);
let db;

async function connectToMongo() {
    try {
        await client.connect();
        db = client.db('cricket-bet-india');
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
    }
}

// 替换文件存储为 MongoDB 集合
const collections = {
    users: 'users',
    bets: 'bets',
    deposits: 'deposits',
    withdrawals: 'withdrawals',
    depositInfo: 'depositInfo',
    matchOdds: 'matchOdds'
};

async function initCollections() {
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
            } else if (key === 'matchOdds') {
                await collection.insertOne({ odds: initialData[key] });
            } else {
                await collection.insertMany(initialData[key]);
            }
        }
    }
}

// CricketData.org API 配置
const CRICKETDATA_API_KEY = '96b0dd75-0754-4c12-816a-efe4d2267e64';

// 获取比赛数据
app.get('/matches', async (req, res) => {
    try {
        let allMatches = [];
        const seriesResponse = await fetch(`https://api.cricapi.com/v1/series?apikey=${CRICKETDATA_API_KEY}`);
        const seriesData = await seriesResponse.json();
        if (seriesData && seriesData.data) {
            for (const series of seriesData.data) {
                const seriesId = series.id;
                const seriesMatchesResponse = await fetch(`https://api.cricapi.com/v1/series_info?apikey=${CRICKETDATA_API_KEY}&id=${seriesId}`);
                const seriesMatchesData = await seriesMatchesResponse.json();
                if (seriesMatchesData && seriesMatchesData.data && seriesMatchesData.data.matchList) {
                    allMatches = allMatches.concat(seriesMatchesData.data.matchList);
                }
            }
        }
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
                if (!apiData || !apiData.data) continue;
                allMatches = allMatches.concat(apiData.data);
            }
        }
        if (allMatches.length === 0) {
            return res.status(500).json({ success: false, message: 'No matches available from API' });
        }
        const matchOddsDoc = await db.collection(collections.matchOdds).findOne();
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
        res.json(matches);
    } catch (error) {
        console.error('Error fetching matches:', error);
        res.status(500).json({ success: false, message: 'Error fetching matches' });
    }
});

// 用户路由
app.post('/register', async (req, res) => {
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

app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ phone });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.json({ success: false, message: 'Invalid credentials' });
    req.session.userId = user.id;
    res.json({ success: true, user });
});

app.post('/profile', async (req, res) => {
    const { userId, bankInfo, cryptoWallet } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ id: userId });
    if (!user) return res.json({ success: false, message: 'User not found' });
    if (bankInfo) user.bankInfo = bankInfo;
    if (cryptoWallet) user.cryptoWallet = cryptoWallet;
    await usersCollection.updateOne({ id: userId }, { $set: { bankInfo: user.bankInfo, cryptoWallet: user.cryptoWallet } });
    res.json({ success: true, user });
});

// 投注路由
app.post('/bet', async (req, res) => {
    const { userId, matchId, team, amount } = req.body;
    const usersCollection = db.collection(collections.users);
    const user = await usersCollection.findOne({ id: userId });
    if (!user || user.balance < amount || amount < 20 || amount > 5000) return res.json({ success: false, message: 'Invalid bet' });
    await usersCollection.updateOne({ id: userId }, { $inc: { balance: -amount } });
    const betsCollection = db.collection(collections.bets);
    await betsCollection.insertOne({ id: Date.now().toString(), userId, matchId, team, amount, status: 'pending' });
    res.json({ success: true, balance: user.balance - amount });
});

// 财务路由
app.get('/deposit-info', async (req, res) => {
    const depositInfoCollection = db.collection(collections.depositInfo);
    const info = await depositInfoCollection.findOne();
    res.json(info);
});

app.post('/deposit', async (req, res) => {
    const { userId, amount, method, transactionId, cryptoAddress } = req.body;
    if (amount < 50 || amount > 20000) return res.json({ success: false, message: 'Invalid amount' });
    const depositsCollection = db.collection(collections.deposits);
    await depositsCollection.insertOne({ id: Date.now().toString(), userId, amount, method, transactionId, cryptoAddress, status: 'pending' });
    res.json({ success: true });
});

app.post('/withdraw', async (req, res) => {
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

// 管理端路由
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
    const ADMIN_USERNAME = 'admin';
    const ADMIN_PASSWORD = 'your-secure-password';
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        return res.json({ success: true, redirect: '/admin' });
    }
    res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/admin-logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, redirect: '/admin-login' });
});

app.get('/admin/users', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const usersCollection = db.collection(collections.users);
    const users = await usersCollection.find().toArray();
    res.json(users);
});

app.delete('/admin/users/:phone', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const usersCollection = db.collection(collections.users);
    await usersCollection.deleteOne({ phone: req.params.phone });
    res.json({ success: true });
});

app.get('/admin/deposits', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const depositsCollection = db.collection(collections.deposits);
    const deposits = await depositsCollection.find().toArray();
    res.json(deposits);
});

app.post('/admin/deposits/:id', async (req, res) => {
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

app.get('/admin/withdrawals', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const withdrawalsCollection = db.collection(collections.withdrawals);
    const withdrawals = await withdrawalsCollection.find().toArray();
    res.json(withdrawals);
});

app.post('/admin/withdrawals/:id', async (req, res) => {
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

app.post('/admin/matches/:id/odds', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { team1Odds, team2Odds } = req.body;
    const matchOddsCollection = db.collection(collections.matchOdds);
    await matchOddsCollection.updateOne({}, { $set: { [`odds.${req.params.id}`]: { team1: parseFloat(team1Odds), team2: parseFloat(team2Odds) } } }, { upsert: true });
    res.json({ success: true });
});

app.post('/admin/matches/:id/result', async (req, res) => {
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

app.post('/admin/deposit-info', async (req, res) => {
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
    });
});
