-- =============================================
-- CREATE ADMIN PROFILE FOR EXISTING USER
-- =============================================

-- First, find your user ID from the screenshot
-- Your UID: 11baeac1-ce21-4e0c-b545-8e4d3500e02d
-- Your Email: g2code331@gmail.com

-- Insert admin profile
INSERT INTO profiles (id, email, username, phone, role, created_at, updated_at)
VALUES (
  '11baeac1-ce21-4e0c-b545-8e4d3500e02d'::uuid,
  'g2code331@gmail.com',
  'ADMIN',
  '+233000000000',
  'admin',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  username = EXCLUDED.username,
  phone = EXCLUDED.phone,
  role = EXCLUDED.role,
  updated_at = NOW();

-- Verify it worked
SELECT * FROM profiles WHERE email = 'g2code331@gmail.com';

-- =============================================
-- ✅ ADMIN PROFILE CREATED!
-- =============================================
