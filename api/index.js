const { createClient } = require('redis');

let redisClient = null;

async function getRedis() {
    if (!redisClient || !redisClient.isOpen) {
        redisClient = createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', (err) => console.log('Redis error:', err));
        await redisClient.connect();
    }
    return redisClient;
}

const API_KEY = process.env.API_KEY || "";
const API_URL = process.env.API_URL || "https://api.deepseek.com/v1/chat/completions";
const API_MODEL = process.env.API_MODEL || "deepseek-chat";
const DEFAULT_FREE_QUOTA = 100;

function simpleHash(str) {
    let hash = 0;
    const data = str + "_SHIKONGJI_SALT_2026";
    for (let i = 0; i < data.length; i++) {
        hash = ((hash << 5) - hash) + data.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function generateToken() {
    return Math.random().toString(36).slice(2) +
           Math.random().toString(36).slice(2) +
           Date.now().toString(36);
}

function json(res, data, status = 200) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    res.status(status).json(data);
}

async function getUser(req, db) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    const token = auth.substring(7);
    const username = await db.get('token:' + token);
    if (!username) return null;
    const userData = await db.get('user:' + username);
    if (!userData) return null;
    const user = JSON.parse(userData);
    return { ...user, username: username };
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        return res.status(200).end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    let db;
    try {
        db = await getRedis();
    } catch (e) {
        return json(res, { error: "数据库连接失败: " + e.message }, 500);
    }

    try {
        // 注册
        if (pathname === '/auth/register' && req.method === 'POST') {
            const { username, password, nickname } = req.body || {};
            if (!username || !password) return json(res, { error: "用户名和密码不能为空" }, 400);
            if (username.length < 3 || username.length > 20) return json(res, { error: "用户名长度 3~20 字符" }, 400);
            if (password.length < 6) return json(res, { error: "密码至少 6 位" }, 400);

            const uname = username.toLowerCase();
            const existing = await db.get('user:' + uname);
            if (existing) return json(res, { error: "用户名已被占用" }, 409);

            const pwdHash = simpleHash(password);
            const userData = {
                password_hash: pwdHash,
                nickname: nickname || username,
                free_quota: DEFAULT_FREE_QUOTA,
                used_quota: 0
            };

            await db.set('user:' + uname, JSON.stringify(userData));

            const token = generateToken();
            await db.set('token:' + token, uname, { EX: 30 * 24 * 60 * 60 });

            return json(res, {
                success: true,
                message: "注册成功！",
                token: token,
                user: {
                    username: uname,
                    nickname: userData.nickname,
                    free_quota: DEFAULT_FREE_QUOTA,
                    used_quota: 0
                }
            });
        }

        // 登录
        if (pathname === '/auth/login' && req.method === 'POST') {
            const { username, password } = req.body || {};
            if (!username || !password) return json(res, { error: "请填写用户名和密码" }, 400);

            const uname = username.toLowerCase();
            const userData = await db.get('user:' + uname);
            if (!userData) return json(res, { error: "用户名或密码错误" }, 401);

            const user = JSON.parse(userData);
            const pwdHash = simpleHash(password);

            if (user.password_hash !== pwdHash) {
                return json(res, { error: "用户名或密码错误" }, 401);
            }

            const token = generateToken();
            await db.set('token:' + token, uname, { EX: 30 * 24 * 60 * 60 });

            return json(res, {
                success: true,
                token: token,
                user: {
                    username: uname,
                    nickname: user.nickname,
                    free_quota: user.free_quota,
                    used_quota: user.used_quota
                }
            });
        }

        // 获取当前用户
        if (pathname === '/auth/me' && req.method === 'GET') {
            const user = await getUser(req, db);
            if (!user) return json(res, { error: "未登录或令牌过期" }, 401);

            return json(res, {
                user: {
                    username: user.username,
                    nickname: user.nickname,
                    free_quota: user.free_quota,
                    used_quota: user.used_quota,
                    remaining: Math.max(0, user.free_quota - user.used_quota)
                }
            });
        }

        // 聊天代理
        if (pathname === '/api/chat' && req.method === 'POST') {
            const user = await getUser(req, db);
            if (!user) return json(res, { error: "请先登录" }, 401);

            if (!API_KEY) return json(res, { error: "服务器未配置 API 密钥" }, 500);

            const remaining = user.free_quota - user.used_quota;
            if (remaining <= 0) {
                return json(res, { error: { message: "免费额度已用完", type: "quota_exceeded" } }, 429);
            }

            const body = req.body || {};
            const apiRes = await fetch(API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + API_KEY
                },
                body: JSON.stringify({
                    model: API_MODEL,
                    messages: body.messages,
                    temperature: body.temperature || 0.9,
                    stream: false
                })
            });

            const apiData = await apiRes.json();

            if (apiData.choices && apiData.choices.length > 0) {
                user.used_quota += 1;
                await db.set('user:' + user.username, JSON.stringify({
                    password_hash: user.password_hash,
                    nickname: user.nickname,
                    free_quota: user.free_quota,
                    used_quota: user.used_quota
                }));

                apiData._panda_quota = {
                    used: user.used_quota,
                    remaining: user.free_quota - user.used_quota,
                    total: user.free_quota
                };
            }

            return json(res, apiData);
        }

        // 服务状态
        return json(res, { service: "时空机 Cloud v2.0", status: "online" });

    } catch (e) {
        return json(res, { error: "服务器错误: " + e.message }, 500);
    }
};
