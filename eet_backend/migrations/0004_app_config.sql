-- Konfigurace z webu, která přebíjí ENV.
--
-- Jednořádková tabulka podle vzoru FioState. Každý sloupec, který je NULL (u
-- tajných polí i prázdný řetězec), znamená "nepřepsáno" — použije se hodnota
-- z prostředí, na kterou se tím pádem dá kdykoli vrátit přes
-- POST /admin/config/reset. Bez toho by nasazený Worker závisel na tom, co
-- někdo naklikal, a `wrangler secret` by přestal být zdrojem pravdy.
--
-- POZOR: fioToken a smtpPassword tu leží v plaintextu, na rozdíl od
-- `wrangler secret`, odkud se nedají přečíst. API je nikdy nevrací (jen
-- příznak "nastaveno"), ale kdokoli s přístupem k D1 je vidí.
CREATE TABLE AppConfig (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fioEnabled INTEGER,              -- NULL = odvoď z přítomnosti tokenu
  fioPollIntervalSeconds INTEGER,  -- NULL = ENV; jinak nejméně 30 (limit Fia)
  fioToken TEXT,                   -- prázdné = ENV
  smtpHost TEXT,
  smtpPort INTEGER,
  smtpSecure TEXT,                 -- tls | starttls | none
  smtpFrom TEXT,
  smtpFromName TEXT,
  smtpUser TEXT,
  smtpPassword TEXT,
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO AppConfig (id) VALUES (1);
