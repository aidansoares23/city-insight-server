// src/index.js
require("dotenv").config(); // loads .env into process.env

const app = require("./app");

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  try {
    // Render-friendly: bind to 0.0.0.0 and PORT from env
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`City Insight API listening on port ${PORT}`);
      console.log(
        `CORS allowlist: ${process.env.CLIENT_ORIGINS || "http://localhost:5173"}`
      );
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
