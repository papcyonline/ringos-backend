-- Add a dedicated Scam/Fraud report reason so scam reports are categorised
-- (previously users had to pick SPAM or OTHER). Additive enum value.
ALTER TYPE "ReportReason" ADD VALUE 'SCAM';
