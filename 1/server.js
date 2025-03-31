const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');

const app = express();

app.use(express.json());
app.use(express.static('public'));

const dataPath = path.join(__dirname, 'data');
const files = {
    users: path.join(dataPath, 'users.json'),
    bets: path.join(dataPath, 'bets.json'),
    deposits: path.join(dataPath, 'deposits.json'),
    withdrawals: path.join(dataPath, 'withdrawals.json'),
    depositInfo: path.join(dataPath, 'deposit-info.json'),
    matchOdds: path.join(dataPath, 'match-odds.json')
};

async function initFiles() {
    await fs.mkdir(dataPath, { recursive: true }).catch(() => {});
    const initialData = {
        users: [],
        bets: [],
        deposits: [],
        withdrawals: [],
        depositInfo: { upi: '', bank: { name: '', ac: '', ifsc: '' }, crypto: '' },
        matchOdds: {}
    };
    for (let [key, file] of Object.entries(files)) {
        const exists = await fs.access(file).then(() => true).catch(() => false);
        const stats = exists ? await fs.stat(file) : null;
        if (!exists || (stats && stats.size === 0)) {
            await fs.writeFile(file, JSON.stringify(initialData[key], null, 2));
        }
    }
}

// CricketData.org API configuration
const CRICKETDATA_API_KEY = '96b0dd75-0754-4c12-816a-efe4d2267e64';

// Get matches data from CricketData.org
app.get('/matches', async (req, res) => {
    try {
        let allMatches = [];

        // 首先尝试从 series 端点获取系列赛列表
        const seriesResponse = await fetch(`https://api.cricapi.com/v1/series?apikey=${CRICKETDATA_API_KEY}`);
        const seriesData = await seriesResponse.json();

        if (!seriesData || !seriesData.data) {
            console.error('Series API response missing data:', seriesData);
        } else {
            console.log(`Fetched ${seriesData.data.length} series`);

            // 遍历系列赛，获取每场比赛
            for (const series of seriesData.data) {
                const seriesId = series.id;
                const seriesMatchesResponse = await fetch(`https://api.cricapi.com/v1/series_info?apikey=${CRICKETDATA_API_KEY}&id=${seriesId}`);
                const seriesMatchesData = await seriesMatchesResponse.json();

                if (seriesMatchesData && seriesMatchesData.data && seriesMatchesData.data.matchList) {
                    console.log(`Fetched ${seriesMatchesData.data.matchList.length} matches for series ${seriesId}`);
                    allMatches = allMatches.concat(seriesMatchesData.data.matchList);
                }
            }
        }

        // 如果 series 端点返回的比赛数量不足，尝试 matches 端点
        if (allMatches.length < 50) {
            console.log('Series endpoint returned insufficient matches, falling back to matches endpoint');
            const matchesPerPage = 25;
            const pagesToFetch = 5; // 获取 5 页数据，总共最多 125 场比赛
            for (let offset = 0; offset < pagesToFetch * matchesPerPage; offset += matchesPerPage) {
                const response = await fetch(`https://api.cricapi.com/v1/matches?apikey=${CRICKETDATA_API_KEY}&offset=${offset}`);
                
                const contentType = response.headers.get('content-type');
                if (!contentType || !contentType.includes('application/json')) {
                    const text = await response.text();
                    console.error(`Non-JSON response received at offset ${offset}:`, text.slice(0, 100));
                    continue;
                }

                const apiData = await response.json();

                if (!apiData || !apiData.data) {
                    console.error(`Matches API response missing data at offset ${offset}:`, apiData);
                    continue;
                }

                console.log(`Fetched ${apiData.data.length} matches at offset ${offset}`);
                allMatches = allMatches.concat(apiData.data);
            }
        }

        if (allMatches.length === 0) {
            console.error('No matches fetched from API after all attempts');
            return res.status(500).json({ success: false, message: 'No matches available from API' });
        }

        console.log(`Total matches fetched: ${allMatches.length}`);

        // 统计比赛类型分布
        const matchTypeCounts = allMatches.reduce((acc, match) => {
            const type = (match.matchType || 'unknown').toUpperCase();
            acc[type] = (acc[type] || 0) + 1;
            return acc;
        }, {});
        console.log('Match type distribution:', matchTypeCounts);

        const matchOdds = JSON.parse(await fs.readFile(files.matchOdds));

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

        // 按时间升序排序（从早到晚）
        matches.sort((a, b) => new Date(a.date) - new Date(b.date));

        res.json(matches);
    } catch (error) {
        console.error('Error fetching matches:', error);
        res.status(500).json({ success: false, message: 'Error fetching matches' });
    }
});

// User Routes
app.post('/register', async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || phone.length !== 10 || !password || password.length < 6) return res.json({ success: false, message: 'Invalid input' });
    let users = JSON.parse(await fs.readFile(files.users));
    if (users.find(u => u.phone === phone)) return res.json({ success: false, message: 'Phone already registered' });
    const user = { id: Date.now().toString(), phone, password, balance: 0, name: `User${Math.floor(Math.random() * 1000)}`, bankInfo: { name: '', ac: '', ifsc: '' }, cryptoWallet: '' };
    users.push(user);
    await fs.writeFile(files.users, JSON.stringify(users));
    res.json({ success: true, user });
});

app.post('/login', async (req, res) => {
    const { phone, password } = req.body;
    const users = JSON.parse(await fs.readFile(files.users));
    const user = users.find(u => u.phone === phone && u.password === password);
    if (!user) return res.json({ success: false, message: 'Invalid credentials' });
    res.json({ success: true, user });
});

app.post('/profile', async (req, res) => {
    const { userId, bankInfo, cryptoWallet } = req.body;
    let users = JSON.parse(await fs.readFile(files.users));
    const user = users.find(u => u.id === userId);
    if (!user) return res.json({ success: false, message: 'User not found' });
    if (bankInfo) user.bankInfo = bankInfo;
    if (cryptoWallet) user.cryptoWallet = cryptoWallet;
    await fs.writeFile(files.users, JSON.stringify(users));
    res.json({ success: true, user });
});

// Bet Routes
app.post('/bet', async (req, res) => {
    const { userId, matchId, team, amount } = req.body;
    let users = JSON.parse(await fs.readFile(files.users));
    const user = users.find(u => u.id === userId);
    if (!user || user.balance < amount || amount < 20 || amount > 5000) return res.json({ success: false, message: 'Invalid bet' });
    user.balance -= amount;
    await fs.writeFile(files.users, JSON.stringify(users));
    let bets = JSON.parse(await fs.readFile(files.bets));
    bets.push({ id: Date.now().toString(), userId, matchId, team, amount, status: 'pending' });
    await fs.writeFile(files.bets, JSON.stringify(bets));
    res.json({ success: true, balance: user.balance });
});

// Finance Routes
app.get('/deposit-info', async (req, res) => {
    const info = JSON.parse(await fs.readFile(files.depositInfo));
    res.json(info);
});

app.post('/deposit', async (req, res) => {
    const { userId, amount, method, transactionId, cryptoAddress } = req.body;
    if (amount < 50 || amount > 20000) return res.json({ success: false, message: 'Invalid amount' });
    let deposits = JSON.parse(await fs.readFile(files.deposits));
    deposits.push({ id: Date.now().toString(), userId, amount, method, transactionId, cryptoAddress, status: 'pending' });
    await fs.writeFile(files.deposits, JSON.stringify(deposits));
    res.json({ success: true });
});

app.post('/withdraw', async (req, res) => {
    const { userId, amount, method } = req.body;
    let users = JSON.parse(await fs.readFile(files.users));
    const user = users.find(u => u.id === userId);
    if (!user || user.balance < amount || amount < 100 || amount > 50000) return res.json({ success: false, message: 'Invalid withdrawal' });
    let withdrawals = JSON.parse(await fs.readFile(files.withdrawals));
    withdrawals.push({ id: Date.now().toString(), userId, amount, method, status: 'pending' });
    await fs.writeFile(files.withdrawals, JSON.stringify(withdrawals));
    res.json({ success: true });
});

// Admin Routes
app.get('/admin/users', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const users = JSON.parse(await fs.readFile(files.users));
    res.json(users);
});

app.delete('/admin/users/:phone', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    let users = JSON.parse(await fs.readFile(files.users));
    users = users.filter(u => u.phone !== req.params.phone);
    await fs.writeFile(files.users, JSON.stringify(users));
    res.json({ success: true });
});

app.get('/admin/deposits', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const deposits = JSON.parse(await fs.readFile(files.deposits));
    res.json(deposits);
});

app.post('/admin/deposits/:id', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { action } = req.body;
    let deposits = JSON.parse(await fs.readFile(files.deposits));
    const deposit = deposits.find(d => d.id === req.params.id);
    if (action === 'approve') {
        let users = JSON.parse(await fs.readFile(files.users));
        const user = users.find(u => u.id === deposit.userId);
        user.balance += parseInt(deposit.amount);
        await fs.writeFile(files.users, JSON.stringify(users));
    }
    deposit.status = action === 'approve' ? 'approved' : 'rejected';
    await fs.writeFile(files.deposits, JSON.stringify(deposits));
    res.json({ success: true });
});

app.get('/admin/withdrawals', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const withdrawals = JSON.parse(await fs.readFile(files.withdrawals));
    res.json(withdrawals);
});

app.post('/admin/withdrawals/:id', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { action } = req.body;
    let withdrawals = JSON.parse(await fs.readFile(files.withdrawals));
    const withdrawal = withdrawals.find(w => w.id === req.params.id);
    if (action === 'approve') {
        let users = JSON.parse(await fs.readFile(files.users));
        const user = users.find(u => u.id === withdrawal.userId);
        user.balance -= parseInt(withdrawal.amount);
        await fs.writeFile(files.users, JSON.stringify(users));
    }
    withdrawal.status = action === 'approve' ? 'approved' : 'rejected';
    await fs.writeFile(files.withdrawals, JSON.stringify(withdrawals));
    res.json({ success: true });
});

app.post('/admin/matches/:id/odds', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { team1Odds, team2Odds } = req.body;
    let matchOdds = JSON.parse(await fs.readFile(files.matchOdds));
    matchOdds[req.params.id] = { team1: parseFloat(team1Odds), team2: parseFloat(team2Odds) };
    await fs.writeFile(files.matchOdds, JSON.stringify(matchOdds));
    res.json({ success: true });
});

app.post('/admin/matches/:id/result', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { winner } = req.body;
    let bets = JSON.parse(await fs.readFile(files.bets));
    let users = JSON.parse(await fs.readFile(files.users));
    let matchOdds = JSON.parse(await fs.readFile(files.matchOdds));
    
    try {
        const response = await fetch(`https://api.cricapi.com/v1/matches/${req.params.id}?apikey=${CRICKETDATA_API_KEY}`);
        const matchData = await response.json();
        const team1 = matchData.data?.teams?.[0] || 'TBD';
        const team2 = matchData.data?.teams?.[1] || 'TBD';

        const match = { id: req.params.id, odds: matchOdds[req.params.id] || { team1: 1.5, team2: 1.5 } };
        bets.filter(b => b.matchId === match.id).forEach(b => {
            if (b.team === (winner === 'team1' ? team1 : team2)) {
                b.status = 'won';
                const user = users.find(u => u.id === b.userId);
                user.balance += b.amount * match.odds[winner];
            } else {
                b.status = 'lost';
            }
        });
    } catch (error) {
        console.error('Error fetching match details:', error);
        return res.status(500).json({ success: false, message: 'Error fetching match details' });
    }

    await fs.writeFile(files.bets, JSON.stringify(bets));
    await fs.writeFile(files.users, JSON.stringify(users));
    res.json({ success: true });
});

app.post('/admin/deposit-info', async (req, res) => {
    if (req.headers['user-id'] !== 'admin123') return res.status(403).json({ success: false, message: 'Unauthorized' });
    const { upi, bank, crypto } = req.body;
    let info = JSON.parse(await fs.readFile(files.depositInfo));
    if (upi) info.upi = upi;
    if (bank) info.bank = bank;
    if (crypto) info.crypto = crypto;
    await fs.writeFile(files.depositInfo, JSON.stringify(info));
    res.json({ success: true });
});

initFiles().then(() => app.listen(3000, () => console.log('Server running on port 3000')));