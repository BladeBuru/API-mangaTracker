/*

This file allows to quickly deploy a local Postgres DB for development
It can be used for instance when shared development DB is not accessible

This file contains the SQL instructions used to set up your local database.

WARNING: Follow the instructions in the README.md

*/

CREATE DATABASE "MangaTracker";

CREATE USER admin WITH PASSWORD 'admin';

\connect "MangaTracker";

CREATE SCHEMA IF NOT EXISTS dev AUTHORIZATION admin;