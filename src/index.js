require("dotenv").config();

const app = require("./app");

const PORT = Number(process.env.PORT) || 3000;

function startServer() {
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`City Insight API listening on port ${PORT}`);
    console.log(
      `CORS allowlist: ${process.env.CLIENT_ORIGINS || "http://localhost:5173"}`,
    );
  });

  server.on("error", (err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

startServer();
