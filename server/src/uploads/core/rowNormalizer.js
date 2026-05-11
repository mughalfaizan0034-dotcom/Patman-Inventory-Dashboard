export function safeString(value) {
  return String(value ?? '').trim();
}

export function parsePositiveInt(raw, field, rowNum) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return { error: { row: rowNum, field, value: raw, reason: `${field} is required` } };

  const n = Number(trimmed);
  if (!Number.isFinite(n))  return { error: { row: rowNum, field, value: raw, reason: `${field} must be a whole number` } };
  if (!Number.isInteger(n)) return { error: { row: rowNum, field, value: raw, reason: `${field} must be a whole number (no decimals)` } };
  if (n < 0)                return { error: { row: rowNum, field, value: raw, reason: `${field} must be positive` } };
  return { value: n };
}

/**
 * Attempts to parse a date string from common export formats.
 * Returns a normalized "YYYY-MM-DD" string, or null if unparseable.
 *
 * Supported formats:
 *   YYYY-MM-DD   (ISO — passthrough)
 *   M/D/YYYY     (US slash — Excel default)
 *   MM/DD/YYYY
 *   M-D-YYYY     (US dash)
 *   MM-DD-YYYY
 *   YYYY/MM/DD
 *   Excel serial number (integer 40000–60000)
 *   JS Date fallback for anything else
 */
export function normalizeDate(raw) {
  const str = String(raw ?? '').trim();
  if (!str) return null;

  // YYYY-MM-DD — already ISO, validate then return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(str + 'T00:00:00');
    return isNaN(d.getTime()) ? null : str;
  }

  // M/D/YYYY or MM/DD/YYYY
  const slashUS = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashUS) {
    return _buildYMD(+slashUS[3], +slashUS[1], +slashUS[2]);
  }

  // YYYY/MM/DD
  const slashISO = str.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashISO) {
    return _buildYMD(+slashISO[1], +slashISO[2], +slashISO[3]);
  }

  // M-D-YYYY or MM-DD-YYYY (must not look like YYYY-MM-DD, already handled above)
  const dashUS = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashUS) {
    return _buildYMD(+dashUS[3], +dashUS[1], +dashUS[2]);
  }

  // Excel serial number
  const serial = Number(str);
  if (Number.isInteger(serial) && serial > 40000 && serial < 60000) {
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    if (!isNaN(date.getTime())) {
      return _buildYMD(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
  }

  // Last-resort JS Date parse (handles "May 11 2026", RFC2822, etc.)
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) {
    return _buildYMD(fallback.getFullYear(), fallback.getMonth() + 1, fallback.getDate());
  }

  return null;
}

function _buildYMD(y, m, d) {
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime()) || date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return null;
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
