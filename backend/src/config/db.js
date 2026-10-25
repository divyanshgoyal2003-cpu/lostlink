
const { Pool } = require("pg");
require("dotenv").config();
const { buildPoolConfig } = require("./database");

const pool = new Pool(buildPoolConfig());

pool.on("error", (err) => {
  // Driver errors can contain host names or SQL details. Keep production logs generic.
  console.error("Unexpected PostgreSQL pool error.");
});

module.exports = pool;
