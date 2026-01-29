//src/index.js
require("dotenv").config(); // loads .env into process.env

const app = require("./app");

const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  try {
    // Start listening
    app.listen(PORT, () => {
      console.log(`City Insight API listening on port ${PORT}`);
      console.log(`CORS allowed origin: ${process.env.CLIENT_ORIGIN || "http://localhost:5173"}`);
      
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();

