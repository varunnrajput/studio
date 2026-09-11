const http = require("http");
const handler = require("./api/index.js");

const PORT = process.env.PORT || 3000;

const server = http.createServer(handler);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Stuvio is running at http://0.0.0.0:${PORT}`);
});