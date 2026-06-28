
const helmet = require('helmet');


const helmetMiddleware = helmet({
  crossOriginEmbedderPolicy: false,
});

module.exports = helmetMiddleware;