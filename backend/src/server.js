
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

const pool = require("./config/db");
const matchesRouter = require("./routes/matches");
const reportsRouter = require("./routes/reports");
const claimsRouter = require("./routes/claims");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use(
  "/api/matches",
  require("./middleware/auth"),
  matchesRouter
);

app.use("/api/reports", reportsRouter);
app.use("/api/claims", claimsRouter);
app.use("/api/auth", require("./routes/auth"));

app.get("/", (req, res) => {
  res.json({
    message: "LostLink API is running",
  });
});

app.get(
  "/api/auth/me",
  require("./middleware/auth"),
  (req, res) => {
    res.json({
      message: "Authentication successful.",
      user: req.user,
    });
  }
);

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT current_database() AS database, NOW() AS server_time"
    );

    res.json({
      status: "ok",
      database: result.rows[0].database,
      serverTime: result.rows[0].server_time,
    });
  } catch (error) {
    console.error(
      "Database health check failed:",
      error.message
    );

    res.status(500).json({
      status: "error",
      message: "Database connection failed",
    });
  }
});

// Start the server only when this file is run directly.
// Tests can import the app without automatically opening port 5000.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `LostLink API running at http://localhost:${PORT}`
    );
  });
}

module.exports = app;
