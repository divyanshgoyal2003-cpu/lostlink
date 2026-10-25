
const jwt = require("jsonwebtoken");
const pool = require("../config/db");

async function authenticateToken(req, res, next) {
  const authorization = req.headers.authorization;

  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ")
  ) {
    return res.status(401).json({
      message: "Authentication required.",
    });
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      message: "Authentication required.",
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return res.status(401).json({
      message: "Invalid or expired authentication token.",
    });
  }

  // Accept user IDs represented as numbers or numeric strings, but never
  // treat the role or account state embedded in a long-lived token as current.
  const userId = Number(decoded?.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return res.status(401).json({ message: "Invalid authentication token." });
  }

  try {
    const result = await pool.query(
      "SELECT role, account_status FROM users WHERE user_id = $1",
      [userId]
    );
    const user = result.rows[0];
    if (!user || user.account_status !== "ACTIVE" ||
        !["USER", "STAFF", "ADMIN"].includes(user.role)) {
      return res.status(401).json({ message: "This account is not active." });
    }

    req.user = { userId, role: user.role };
    return next();
  } catch (error) {
    console.error("Authentication account lookup failed.");
    return res.status(503).json({ message: "Authentication is temporarily unavailable." });
  }
}

module.exports = authenticateToken;
