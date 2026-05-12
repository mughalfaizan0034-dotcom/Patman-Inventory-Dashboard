-- Migration: 001_orders_sku_resolution
-- Run in BigQuery console BEFORE deploying this backend version.
-- Adds SKU resolution and ignore tracking columns to the orders table.

ALTER TABLE `patman_inventory.orders`
  ADD COLUMN IF NOT EXISTS is_ignored          BOOL,
  ADD COLUMN IF NOT EXISTS mapped_inventory_sku STRING,
  ADD COLUMN IF NOT EXISTS ignored_at           TIMESTAMP,
  ADD COLUMN IF NOT EXISTS ignored_by           STRING,
  ADD COLUMN IF NOT EXISTS mapped_at            TIMESTAMP,
  ADD COLUMN IF NOT EXISTS mapped_by            STRING;
