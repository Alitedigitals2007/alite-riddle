const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. NEON DATABASE CONNECTION
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// 2. MIDDLEWARE & SETTINGS
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. ROUTES

// Home Page
app.get('/', (req, res) => {
    res.render('home'); 
});

// Admin Page (For later)
// Updated Admin Route with Stats
app.get('/admin', async (req, res) => {
    try {
        const questionCount = await pool.query('SELECT COUNT(*) FROM riddles');
        const userCount = await pool.query('SELECT COUNT(*) FROM users'); // Assumes you have a users table
        
        res.render('admin', { 
            questions: questionCount.rows[0].count, 
            users: userCount.rows[0].count,
            error: null 
        });
    } catch (err) {
        res.render('admin', { questions: 0, users: 0, error: "Database Connection Error" });
    }
});

// Admin Dashboard Route
app.get('/admin', (req, res) => {
    res.render('admin');
});

// Admin Import Logic (POST)
app.post('/admin/import', async (req, res) => {
    const { riddles } = req.body; // Expecting an array of riddles
    try {
        for (let r of riddles) {
            await pool.query(
                'INSERT INTO riddles (question, option_a, option_b, option_c, option_d, answer) VALUES ($1, $2, $3, $4, $5, $6)',
                [r.question, r.option_a, r.option_b, r.option_c, r.option_d, r.answer]
            );
        }
        res.json({ success: true, message: `${riddles.length} riddles imported!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Sign In Route
app.get('/signin', (req, res) => {
    res.render('signin');
});

const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// 1. Session Setup (Must be BEFORE passport.initialize)
// 1. Session must come first
app.use(session({
    secret: 'alite_secret_key',
    resave: false,
    saveUninitialized: true
}));

// 2. Initialize Passport
app.use(passport.initialize());

// 3. MUST come after passport.initialize and BEFORE your routes
app.use(passport.session());

// 2. Google Strategy
passport.use(new GoogleStrategy({
    clientID: "386993811253-3g3cjkq8nkp43f5fns33m8pclk1cifq3.apps.googleusercontent.com",
    clientSecret: "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",
    callbackURL: "/auth/google/callback",
    proxy: true
  },
async (accessToken, refreshToken, profile, done) => {
  try {
    const googleId = profile.id;
    const email = profile.emails[0].value;
    const name = profile.displayName;

    // This query handles everything: 
    // It tries to insert, but if google_id exists, it just returns the existing user.
    const query = `
      INSERT INTO users (google_id, username, email) 
      VALUES ($1, $2, $3) 
      ON CONFLICT (google_id) 
      DO UPDATE SET username = EXCLUDED.username, email = EXCLUDED.email
      RETURNING *;
    `;

    const res = await pool.query(query, [googleId, name, email]);
    
    // Return the user (either the newly created one or the updated existing one)
    return done(null, res.rows[0]);

  } catch (err) {
    console.error("CRITICAL AUTH ERROR:", err);
    return done(err, null);
  }
}
));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
    const res = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, res.rows[0]);
});

// 1. This sends the user to Google
app.get('/auth/google', passport.authenticate('google', { 
    scope: ['profile', 'email'] 
}));

// 2. This is where Google sends the user back
app.get('/auth/google/callback', 
    passport.authenticate('google', { failureRedirect: '/signin' }),
    (req, res) => {
        res.redirect('/dashboard'); 
    }
);

// Logout
app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// 1. Protection Middleware (Must be defined before the routes)
function isLoggedIn(req, res, next) {
    if (req.isAuthenticated()) {
        return next();
    }
    res.redirect('/signin');
}

{
    connectionStateRecovery: {}, 
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// CREATE ROOM FIX
socket.on('create_room', async (data) => {
    // Generate a 5-character clean code
    const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    
    const initialData = {
        mode: data.mode || '1v1', 
        players: [{ id: socket.id, username: data.username }],
        status: 'waiting'
    };

    try {
        // Use JSON.stringify only if your column is TEXT. 
        // If it's JSONB, most drivers handle the object directly.
        await pool.query(
            'INSERT INTO rooms (room_code, room_data) VALUES ($1, $2)', 
            [roomCode, initialData] 
        );
        
        socket.join(roomCode);
        socket.emit('room_created', { roomCode });
        console.log(`Room Created: ${roomCode}`);
    } catch (err) {
        console.error("Error creating room:", err);
        socket.emit('error_message', 'Failed to create room.');
    }
});

// JOIN ROOM FIX
socket.on('join_room', async (data) => {
    const { roomCode, username } = data;

    try {
        const result = await pool.query('SELECT * FROM rooms WHERE room_code = $1', [roomCode]);

        if (result.rows.length === 0) {
            return socket.emit('error_message', 'Room not found.');
        }

        // Handle JSON parsing safety
        let roomData = typeof result.rows[0].room_data === 'string' 
            ? JSON.parse(result.rows[0].room_data) 
            : result.rows[0].room_data;

        // Prevent joining if room is full (e.g., for 1v1)
        if (roomData.mode === '1v1' && roomData.players.length >= 2) {
            return socket.emit('error_message', 'Room is full.');
        }

        // Add the new player
        roomData.players.push({ id: socket.id, username: username });

        // Update DB
        await pool.query('UPDATE rooms SET room_data = $1 WHERE room_code = $2', 
            [roomData, roomCode]);

        socket.join(roomCode);
        
        // Use io.to().emit to tell EVERYONE in the room (including the creator)
        io.to(roomCode).emit('player_joined', roomData);
        
        // If 2 players are in, trigger the start
        if (roomData.players.length === 2) {
            io.to(roomCode).emit('start_game', roomData);
        }

    } catch (err) {
        console.error("Error joining room:", err);
        socket.emit('error_message', 'Server error during join.');
    }
});
app.get('/dashboard', isLoggedIn, async (req, res) => {
    try {
        // 1. Fetch Top 10 Players (Ranked by Level, then Points)
        const leaderRes = await pool.query(
            'SELECT username, current_level, points FROM users ORDER BY current_level DESC, points DESC LIMIT 10'
        );

        // 2. Calculate User's Global Rank
        const rankRes = await pool.query(
            'SELECT COUNT(*) + 1 as rank FROM users WHERE current_level > $1 OR (current_level = $1 AND points > $2)',
            [req.user.current_level, req.user.points]
        );

        // 3. Get total riddles count for the "Available" stat
        const totalRiddles = await pool.query('SELECT COUNT(*) FROM riddles');

        res.render('dashboard', {
            user: req.user,
            leaders: leaderRes.rows,
            rank: rankRes.rows[0].rank,
            totalRiddles: totalRiddles.rows[0].count
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});
app.get('/leaderboard', isLoggedIn, async (req, res) => {
    try {
        // Fetch top 50 players ranked by level then points
        const leaders = await pool.query(`
            SELECT username, current_level, points 
            FROM users 
            ORDER BY current_level DESC, points DESC 
            LIMIT 50
        `);

        // Find current user's rank
        const rankRes = await pool.query(`
            SELECT COUNT(*) + 1 as rank 
            FROM users 
            WHERE current_level > $1 OR (current_level = $1 AND points > $2)
        `, [req.user.current_level, req.user.points]);

        res.render('leaderboard', {
            leaders: leaders.rows,
            user: req.user,
            userRank: rankRes.rows[0].rank
        });
    } catch (err) {
        res.status(500).send("Error loading leaderboard");
    }
});

// GET Battle Arena
app.get('/battle', isLoggedIn, async (req, res) => {
    try {
        // We pass the user object so battle.ejs can access username and id for the socket handshake
        res.render('battle', { 
            user: req.user,
            title: "Battle Arena | Alite Riddles" 
        });
    } catch (err) {
        console.error("Error loading battle arena:", err);
        res.redirect('/dashboard');
    }
});
// --- BATTLE ARENA SOCKET LOGIC ---
let waitingPlayer = null;

io.on('connection', (socket) => {
    socket.on('findMatch', async (data) => {
        // Prevent matching with self
        if (waitingPlayer && waitingPlayer.userId !== data.userId) {
            const room = `room_${waitingPlayer.userId}_${data.userId}`;
            const opponent = waitingPlayer;

            socket.join(room);
            opponent.socket.join(room);

            // Fetch 5 random riddles
            const riddles = await pool.query('SELECT * FROM riddles ORDER BY RANDOM() LIMIT 5');

            io.to(room).emit('matchStarted', {
                room: room,
                riddles: riddles.rows,
                opponentName: opponent.username,
                opponentId: opponent.userId
            });
            waitingPlayer = null;
        } else {
            waitingPlayer = { 
                socket: socket, 
                userId: data.userId, 
                username: data.username 
            };
        }
    });

    // RELAY: When you answer, tell your opponent to show the "Glow"
    socket.on('send-answer', (data) => {
        socket.to(data.roomId).emit('opponent-answered', {
            newScore: data.newScore,
            isCorrect: data.isCorrect
        });
    });

    // FINAL: Inject points into DB
    socket.on('battleComplete', async (data) => {
        const { userId, pointsWon } = data;
        try {
            await pool.query('UPDATE users SET points = points + $1 WHERE id = $2', [pointsWon, userId]);
            const userRes = await pool.query('SELECT points FROM users WHERE id = $1', [userId]);
            socket.emit('pointsUpdated', { newTotal: userRes.rows[0].points });
        } catch (err) {
            console.error("Battle DB Error:", err);
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.socket.id === socket.id) waitingPlayer = null;
    });
});
// --- LOBBY SYSTEM STORAGE ---
let lobbies = {}; 

io.on('connection', (socket) => {
    
    // 1. Create a Room
    socket.on('createRoom', (data) => {
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        const lobbyType = data.type; // 'single' or 'team'
        
        lobbies[roomId] = {
            id: roomId,
            type: lobbyType,
            creator: data.username,
            players: [{ id: socket.id, username: data.username, userId: data.userId, team: 'A' }],
            status: 'waiting'
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, lobbyType });
    });

    // 2. Join a Room
    socket.on('joinRoom', (data) => {
        const room = lobbies[data.roomId];
        
        if (room && room.status === 'waiting') {
            // Check if room is full (2 for single, 4 for team)
            const maxPlayers = room.type === 'single' ? 2 : 4;
            
            if (room.players.length < maxPlayers) {
                const team = room.players.length % 2 === 0 ? 'A' : 'B';
                room.players.push({ id: socket.id, username: data.username, userId: data.userId, team });
                
                socket.join(data.roomId);
                io.to(data.roomId).emit('playerJoined', { players: room.players });

                // Auto-start if full
                if (room.players.length === maxPlayers) {
                    room.status = 'playing';
                    startMatch(data.roomId, room);
                }
            } else {
                socket.emit('error', 'Room is full!');
            }
        } else {
            socket.emit('error', 'Room not found!');
        }
    });

    async function startMatch(roomId, room) {
        const riddles = await pool.query('SELECT * FROM riddles ORDER BY RANDOM() LIMIT 5');
        io.to(roomId).emit('matchStarted', { riddles: riddles.rows, type: room.type });
    }

    // 3. Real-time Score Relay (Now supports Team Aggregation)
    socket.on('send-answer', (data) => {
        // In Team mode, this broadcasts the score to teammates and enemies alike
        socket.to(data.roomId).emit('opponent-answered', {
            userId: data.userId,
            newScore: data.newScore,
            team: data.team
        });
    });
});
// Global storage for active lobbies
const activeLobbies = {};

io.on('connection', (socket) => {
    
    // --- CREATE ROOM ---
    socket.on('createRoom', async (data) => {
        // Generate a 5-digit unique code
        const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
        
        activeLobbies[roomId] = {
            roomId: roomId,
            type: data.type, // 'single' or 'team'
            players: [{ 
                id: socket.id, 
                userId: data.userId, 
                username: data.username, 
                team: 'A', 
                score: 0 
            }],
            status: 'waiting'
        };

        socket.join(roomId);
        socket.emit('roomCreated', { roomId, lobbyType: data.type });
    });

    // --- JOIN ROOM ---
    socket.on('joinRoom', async (data) => {
        const room = activeLobbies[data.roomId];

        if (room && room.status === 'waiting') {
            const maxPlayers = room.type === 'single' ? 2 : 4;

            if (room.players.length < maxPlayers) {
                // Assign Teams: Players 1 & 3 are Team A, Players 2 & 4 are Team B
                const team = (room.players.length % 2 === 0) ? 'A' : 'B';
                
                room.players.push({ 
                    id: socket.id, 
                    userId: data.userId, 
                    username: data.username, 
                    team: team, 
                    score: 0 
                });

                socket.join(data.roomId);

                // Check if match should start
                if (room.players.length === maxPlayers) {
                    room.status = 'playing';
                    
                    // FETCH RANDOM QUESTIONS FROM DB
                    const riddleRes = await pool.query('SELECT * FROM riddles ORDER BY RANDOM() LIMIT 5');
                    
                    io.to(data.roomId).emit('matchStarted', {
                        roomId: data.roomId,
                        riddles: riddleRes.rows,
                        type: room.type,
                        players: room.players // Clients use this to see who is on which team
                    });
                } else {
                    io.to(data.roomId).emit('playerJoined', { count: room.players.length });
                }
            } else {
                socket.emit('error', 'Room is full!');
            }
        } else {
            socket.emit('error', 'Invalid Room Code');
        }
    });

    // --- REAL-TIME SCORE RELAY ---
    socket.on('send-answer', (data) => {
        const room = activeLobbies[data.roomId];
        if (!room) return;

        // Find the player in the lobby and update their individual score
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.score = data.newScore;

        // Calculate Team Totals
        const teamAScore = room.players.filter(p => p.team === 'A').reduce((sum, p) => sum + p.score, 0);
        const teamBScore = room.players.filter(p => p.team === 'B').reduce((sum, p) => sum + p.score, 0);

        // Broadcast the update to everyone else in the room
        socket.to(data.roomId).emit('opponent-answered', {
            senderId: data.userId,
            isCorrect: data.isCorrect,
            teamAScore: teamAScore,
            teamBScore: teamBScore,
            individualScore: data.newScore
        });
    });
});

// --- 1. SOLO GAME ROUTE ---
app.get('/solo', isLoggedIn, async (req, res) => {
    try {
        // 1. Get user's current level (Campaign Level)
        const userLevel = req.user.current_level || 1;

        // 2. Manage the session index (which question out of 10)
        // If it's the first question, set it to 0
        if (req.session.current_q_index === undefined) {
            req.session.current_q_index = 0;
        }

        // 3. Calculate which riddle to show
        // Offset skips the questions from previous levels
        const offset = (userLevel - 1) * 10;
        const riddleRes = await pool.query(
            'SELECT * FROM riddles ORDER BY id ASC LIMIT 1 OFFSET $1', 
            [offset + req.session.current_q_index]
        );

        if (riddleRes.rows.length === 0) {
            return res.send("Congratulations! You've finished all available levels.");
        }

        // 4. THE FIX: Render with qNumber defined
        res.render('solo', { 
            riddle: riddleRes.rows[0], 
            user: req.user,
            qNumber: req.session.current_q_index + 1 // This defines it for EJS!
        });

    } catch (err) {
        console.error("Solo Route Error:", err);
        res.redirect('/level-map');
    }
});
// --- 2. LEVEL MAP ROUTE ---
app.get('/level-map', isLoggedIn, async (req, res) => {
    // We assume 100 levels for now
    const totalLevels = 100; 
    res.render('level-map', { 
        user: req.user, 
        totalLevels: totalLevels 
    });
});

app.get('/start-level/:id', isLoggedIn, (req, res) => {
    // 1. Reset the level progress counters
    req.session.current_q_index = 0;
    req.session.correct_count = 0;
    
    // 2. Take them to the game
    res.redirect('/solo');
});
app.post('/check-answer', isLoggedIn, async (req, res) => {
    const { riddleId, selectedOption } = req.body;
    
    // Initialize counters if they don't exist
    if (req.session.correct_count === undefined) req.session.correct_count = 0;

    try {
        const result = await pool.query('SELECT answer FROM riddles WHERE id = $1', [riddleId]);
        const dbAns = String(result.rows[0].answer).trim().toUpperCase().charAt(0);
        const userAns = String(selectedOption).trim().toUpperCase().charAt(0);

        const isCorrect = dbAns === userAns;
        if (isCorrect) req.session.correct_count++;
        
        // Move to next question index
        req.session.current_q_index++;

        let levelUp = false;
        let message = isCorrect ? "Correct!" : "Wrong!";

        // Check if level finished (10 questions completed)
        // Inside your app.post('/check-answer') ...

if (req.session.current_q_index >= 10) {
    if (req.session.correct_count >= 8) {
        // Only update if they are completing their HIGHEST unlocked level
        if (req.user.current_level <= (req.session.playing_level || req.user.current_level)) {
            await pool.query('UPDATE users SET current_level = current_level + 1 WHERE id = $1', [req.user.id]);
            levelUp = true;
        }
        message = "LEVEL PASSED! 🏆";
    } else {
        message = "Level Failed. You need 8/10 to advance.";
    }
    // Clear for next attempt
    req.session.current_q_index = 0;
    req.session.correct_count = 0;
}
        res.json({ 
            success: isCorrect, 
            correctLetter: dbAns, 
            levelUp: levelUp, 
            message: message 
        });

    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// --- 2. THE SCOREBOARD ROUTE ---
app.get('/api/scoreboard', async (req, res) => {
    try {
        const result = await pool.query('SELECT username, points, level FROM users ORDER BY points DESC LIMIT 5');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

// 5. START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ✅ ALITE RIDDLES SERVER ACTIVE
    🔗 Local URL: http://localhost:${PORT}
    📂 Current File: app.js
    `);
});
