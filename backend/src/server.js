
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const { validateProductionEnvironment } = require("./config/production");
const { allowedOrigins } = validateProductionEnvironment();

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
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Photo-Type", "X-Proof-Note"],
  maxAge: 600,
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

app.use(
  "/api/matches",
  require("./middleware/auth"),
  matchesRouter
);

app.use("/api/reports", reportsRouter);
app.use("/api/claims", claimsRouter);
app.use("/api/authorities", require("./routes/authorities").router);
app.use("/api/conversations", require("./routes/conversations"));
app.use("/api/notifications", require("./routes/notifications"));
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
    await pool.query("SELECT 1");

    res.json({ status: "ok" });
  } catch (error) {
    console.error("Database health check failed.", {
      name: error?.name || "Error",
      code: error?.code || "NO_CODE",
    });

    res.status(500).json({
      status: "error",
      message: "Database connection failed",
    });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (process.env.NODE_ENV === "production") {
    return res.status(error.status >= 400 && error.status < 500 ? error.status : 500)
      .json({ error: error.status >= 400 && error.status < 500 ? "Invalid request" : "Internal server error" });
  }
  return res.status(error.status || 500).json({ error: error.message || "Internal server error" });
});

// Start the server only when this file is run directly.
// Tests can import the app without automatically opening port 5000.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("LostLink API server listening.");
  });
}

module.exports = app;
