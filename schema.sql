-- schema.sql
-- Drop existing table if it exists (for clean deployments)
DROP TABLE IF EXISTS images;

-- Create images table with proper schema
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_key TEXT NOT NULL UNIQUE,        -- R2 object key (e.g., 'lisbon-city.png')
  alt_text TEXT,                          -- AI-generated description
  content_type TEXT NOT NULL,             -- MIME type (image/png, image/jpeg)
  file_size INTEGER,                      -- Size in bytes
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_image_key ON images(image_key);

-- Seed data for your existing images
-- These must match the filenames you'll upload to R2
INSERT INTO images (image_key, content_type, file_size, alt_text) 
VALUES 
  ('lisbon-city.png', 'image/png', NULL, NULL),
  ('mangrove.jpg', 'image/jpeg', NULL, NULL);
