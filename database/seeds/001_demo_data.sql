-- Fictional demo data for testing only. Password hashes are placeholders and cannot be used to log in.
BEGIN;

INSERT INTO users (user_id, name, email, phone, password_hash, role)
OVERRIDING SYSTEM VALUE VALUES
(1, 'Demo Lost Reporter', 'lost.demo@example.test', NULL, 'NOT_A_REAL_PASSWORD_HASH', 'USER'),
(2, 'Demo Finder', 'found.demo@example.test', NULL, 'NOT_A_REAL_PASSWORD_HASH', 'USER'),
(3, 'Demo Staff', 'staff.demo@example.test', NULL, 'NOT_A_REAL_PASSWORD_HASH', 'STAFF')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO items (item_id, category, title, description, color, attributes_json)
OVERRIDING SYSTEM VALUE VALUES
(1, 'ELECTRONICS', 'Black wireless earbuds case', 'Small black charging case; demonstration report.', 'Black', '{"brand":"ExampleBrand","distinctive_mark":"small scratch"}'),
(2, 'ELECTRONICS', 'Black earbuds charging case', 'Found black case near a food stall; demonstration report.', 'Black', '{"brand":"ExampleBrand"}')
ON CONFLICT (item_id) DO NOTHING;

INSERT INTO electronics (item_id, brand, model)
VALUES (1, 'ExampleBrand', 'Demo Model'), (2, 'ExampleBrand', NULL)
ON CONFLICT (item_id) DO NOTHING;

-- Coordinates are fictional test points only; not a real report.
INSERT INTO reports
(report_id, user_id, item_id, report_type, report_time, status, location_point,
 uncertainty_radius_m, location_accuracy_m, location_source, location_description)
OVERRIDING SYSTEM VALUE VALUES
(1, 1, 1, 'LOST', NOW() - INTERVAL '4 hours', 'OPEN',
 ST_SetSRID(ST_MakePoint(77.59460, 12.97160), 4326)::geography,
 100, 15, 'MAP_PIN', 'Near a row of food stalls'),
(2, 2, 2, 'FOUND', NOW() - INTERVAL '3 hours', 'OPEN',
 ST_SetSRID(ST_MakePoint(77.59485, 12.97172), 4326)::geography,
 10, 8, 'GPS', 'Beside a red food cart')
ON CONFLICT (report_id) DO NOTHING;

-- Keep identity sequences in sync after explicit seed IDs.
SELECT setval(pg_get_serial_sequence('users','user_id'), GREATEST((SELECT MAX(user_id) FROM users), 1));
SELECT setval(pg_get_serial_sequence('items','item_id'), GREATEST((SELECT MAX(item_id) FROM items), 1));
SELECT setval(pg_get_serial_sequence('reports','report_id'), GREATEST((SELECT MAX(report_id) FROM reports), 1));

COMMIT;
