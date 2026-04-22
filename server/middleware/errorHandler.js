/**
 * Global Express error handler.
 * Must be registered LAST with app.use() after all routes.
 * Catches any error passed via next(err).
 */
const errorHandler = (err, req, res, next) => {
  // Log full stack in development, just message in production
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[Error] ${err.stack}`);
  } else {
    console.error(`[Error] ${err.message}`);
  }

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
};

module.exports = errorHandler;
