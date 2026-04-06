// ============================================================
// 🐼 时空机云端账号系统 V1.0
// 平台：Vercel Serverless Functions
// ============================================================

// ⚠️ 你的真实 API 密钥（后面会教你怎么安全地填）
const API_KEY = process.env.API_KEY || "";
const API_URL = process.env.API_URL || "https://api.deepseek.com/v1/chat/completions";
const API_MODEL = process.env.API_MODEL || "deepseek-chat";
const DEFAULT_FREE_QUOTA = 100;

// ========== 内存数据库（轻量版，后续可升级） ==========
// 注意：Vercel 免费版每次冷启动会重置内存，
// 所以我们用文件系统的 /tmp 目录做临时持久化
const fs = require('fs');
const path = require('path');
const DB_PATH = '/tmp/shikongji_db.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch(e) {}
  return { users: {}, tokens: {} };
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db));
  } catch(e) {}
}

// ========== 工具函数 ==========
function simpleHash(str) {
  let hash = 0;
  const salt = "_SHIKONGJI_SALT_2026";
  const data = str + salt;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
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

function getUser(req, db) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.substring(7);
  const tokenData = db.tokens[token];
  if (!tokenData) return null;
  if (Date.now() > tokenData.expires) {
    delete db.tokens[token];
    return null;
  }
  const user = db.users[tokenData.username];
  if (!user) return null;
  return { ...user, username: tokenData.username };
}

// ========== 主处理函数 ==========
module.exports = async function handler(req, res) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = loadDB();

  try {
    // ==========================================
    //  📝 注册
    // ==========================================
    if (pathname === '/auth/register' && req.method === 'POST') {
      const { username, password, nickname } = req.body || {};

      if (!username || !password) {
        return json(res, { error: "用户名和密码不能为空" }, 400);
      }
      if (username.length < 3 || username.length > 20) {
        return json(res, { error: "用户名长度 3~20 字符" }, 400);
      }
      if (password.length < 6) {
        return json(res, { error: "密码至少 6 位" }, 400);
      }

      const uname = username.toLowerCase();
      if (db.users[uname]) {
        return json(res, { error: "用户名已被占用" }, 409);
      }

      const pwdHash = simpleHash(password);
      db.users[uname] = {
        password_hash: pwdHash,
        nickname: nickname || username,
        created_at: new Date().toISOString(),
        is_banned: false,
        is_vip: false,
        free_quota: DEFAULT_FREE_QUOTA,
        used_quota: 0
      };

      const token = generateToken();
      db.tokens[token] = {
        username: uname,
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000
      };

      saveDB(db);

      return json(res, {
        success: true,
        message: "注册成功！",
        token: token,
        user: {
          username: uname,
          nickname: nickname || username,
          free_quota: DEFAULT_FREE_QUOTA,
          used_quota: 0
        }
      });
    }

    // ==========================================
    //  🔑 登录
    // ==========================================
    if (pathname === '/auth/login' && req.method === 'POST') {
      const { username, password } = req.body || {};

      if (!username || !password) {
        return json(res, { error: "请填写用户名和密码" }, 400);
      }

      const uname = username.toLowerCase();
      const user = db.users[uname];
      const pwdHash = simpleHash(password);

      if (!user || user.password_hash !== pwdHash) {
        return json(res, { error: "用户名或密码错误" }, 401);
      }
      if (user.is_banned) {
        return json(res, { error: "该账号已被封禁" }, 403);
      }

      // 清理旧令牌
      for (let t in db.tokens) {
        if (db.tokens[t].username === uname) delete db.tokens[t];
      }

      const token = generateToken();
      db.tokens[token] = {
        username: uname,
        expires: Date.now() + 30 * 24 * 60 * 60 * 1000
      };

      saveDB(db);

      return json(res, {
        success: true,
        token: token,
        user: {
          username: uname,
          nickname: user.nickname,
          is_vip: !!user.is_vip,
          free_quota: user.free_quota,
          used_quota: user.used_quota
        }
      });
    }

    // ==========================================
    //  👤 获取当前用户信息
    // ==========================================
    if (pathname === '/auth/me' && req.method === 'GET') {
      const user = getUser(req, db);
      if (!user) return json(res, { error: "未登录或令牌过期" }, 401);

      return json(res, {
        user: {
          username: user.username,
          nickname: user.nickname,
          is_vip: !!user.is_vip,
          free_quota: user.free_quota,
          used_quota: user.used_quota,
          remaining: Math.max(0, user.free_quota - user.used_quota)
        }
      });
    }

    // ==========================================
    //  💬 代理聊天（带账号额度校验）
    // ==========================================
    if (pathname === '/api/chat' && req.method === 'POST') {
      const user = getUser(req, db);
      if (!user) return json(res, { error: "请先登录" }, 401);
      if (user.is_banned) return json(res, { error: "账号已被封禁" }, 403);

      if (!API_KEY) {
        return json(res, { error: "服务器未配置 API 密钥，请联系管理员" }, 500);
      }

      // VIP 不限额度
      if (!user.is_vip) {
        const remaining = user.free_quota - user.used_quota;
        if (remaining <= 0) {
          return json(res, {
            error: {
              message: `免费额度已用完（${user.used_quota}/${user.free_quota}条）！`,
              type: "quota_exceeded"
            }
          }, 429);
        }
      }

      const body = req.body || {};

      // 转发给真实 API
      const apiRes = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: API_MODEL,
          messages: body.messages,
          temperature: body.temperature || 0.9,
          stream: false
        })
      });

      const apiData = await apiRes.json();

      // 成功才扣额度
      if (apiData.choices && apiData.choices.length > 0 && !user.is_vip) {
        db.users[user.username].used_quota += 1;
        saveDB(db);

        apiData._panda_quota = {
          used: user.used_quota + 1,
          remaining: user.free_quota - user.used_quota - 1,
          total: user.free_quota
        };
      }

      return json(res, apiData);
    }

    // ==========================================
    //  📊 服务状态
    // ==========================================
    return json(res, {
      service: "时空机 Cloud v1.0",
      status: "online",
      users: Object.keys(db.users).length
    });

  } catch (e) {
    return json(res, { error: "服务器内部错误: " + e.message }, 500);
  }
};
