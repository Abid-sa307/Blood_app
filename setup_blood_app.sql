-- setup_blood_app.sql
-- Creates DB + table for the Blood Directory app.
-- Safe to run multiple times.

-- 1) Create database (UTF-8, case-insensitive)
CREATE DATABASE IF NOT EXISTS `blood_app`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

-- If your MySQL/MariaDB doesn't support utf8mb4_0900_ai_ci,
-- replace with: utf8mb4_unicode_ci

-- 2) Use the database
USE `blood_app`;

-- 3) Create table
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(128) NOT NULL,
  `contact` VARCHAR(32) NOT NULL,
  `blood_group` ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_bg` (`blood_group`),
  INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- (Optional) If you want a dedicated app user instead of root, uncomment and set a strong password:
-- CREATE USER IF NOT EXISTS 'blood_app_user'@'localhost' IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
-- GRANT SELECT, INSERT ON `blood_app`.* TO 'blood_app_user'@'localhost';
-- FLUSH PRIVILEGES;

-- (Optional quick checks you can run after inserting some data)
-- SELECT COUNT(*) AS total_users FROM users;
-- SELECT blood_group, COUNT(*) AS c FROM users GROUP BY blood_group ORDER BY blood_group;
