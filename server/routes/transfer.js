const express = require('express');
const router = express.Router();
const { getFaresDb, getLinesDb } = require('../db');

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function formatLineId(id) {
  if (id > 999) return `${Math.floor(id / 10)}-${id % 10}`;
  return String(id);
}

/** Returns true if a card description is a real name (not a KT_N placeholder) */
function isNamedCard(description) {
  const d = (description || '').trim();
  return d.length > 0 && !/^KT_\d+$/i.test(d);
}

/** Format card description: "TAM KART" → "TAM KART (1)" */
function formatCardLabel(description, id) {
  const d = (description || '').trim();
  return `${d} (${id})`;
}

/** Resolve actual line_id from display id (e.g. "100-1" → 1001, "140" → 140) */
function resolveLineId(input) {
  const n = parseInt(input);
  return isNaN(n) ? null : n;
}

/** Given a line_id, get its stop_type from line_stops (most common) */
function getLineStopType(linesDb, lineId) {
  const row = linesDb.prepare(`
    SELECT stop_type, COUNT(*) as cnt
    FROM line_stops WHERE line_id = ?
    GROUP BY stop_type ORDER BY cnt DESC LIMIT 1
  `).get(lineId);
  return row ? row.stop_type : 1;
}

/** Given a line_id, get its weekly_time_table_id (direction 0) */
function getWeeklyTTId(faresDb, lineId) {
  const row = faresDb.prepare(`
    SELECT weekly_time_table_id FROM line_time_tables
    WHERE line_id = ? AND direction = 0 LIMIT 1
  `).get(lineId);
  return row ? row.weekly_time_table_id : 1;
}

/** Given weekday (0=Mon..6=Sun) and time in minutes, find time_zone_id */
function getTimeZoneId(faresDb, weeklyTTId, weekday, timeMinutes) {
  // Get daily_time_table_id for this weekday
  const dayRow = faresDb.prepare(`
    SELECT daily_time_table_id FROM weekly_time_tables
    WHERE weekly_time_table_id = ? AND weekday_id = ? LIMIT 1
  `).get(weeklyTTId, weekday);
  
  if (!dayRow) return 0;
  
  // Get all time points for this daily table, sorted descending
  const timePoints = faresDb.prepare(`
    SELECT time_point, time_zone_id FROM daily_time_tables
    WHERE daily_time_table_id = ?
    ORDER BY time_point DESC
  `).all(dayRow.daily_time_table_id);
  
  // Find the highest time_point <= timeMinutes
  for (const tp of timePoints) {
    if (timeMinutes >= tp.time_point) {
      return tp.time_zone_id;
    }
  }
  return 0;
}

/** Get fare for a line at a given stop_type, time_zone, card_type */
function getTicketFare(faresDb, stopType, timeZoneId, cardTypeId) {
  const row = faresDb.prepare(`
    SELECT f.fare FROM ticket_fares tf
    JOIN fares f ON f.fare_id = tf.fare_id
    WHERE tf.stop_type = ? AND tf.time_zone_id = ? AND tf.card_type_id = ?
    LIMIT 1
  `).get(stopType, timeZoneId, cardTypeId);
  return row ? row.fare : null;
}

/** Check manual fare for a line */
function getManualFare(faresDb, lineId) {
  const row = faresDb.prepare('SELECT manual_fare_table_id FROM line_manual_fare WHERE line_id = ? LIMIT 1').get(lineId);
  return row ? row.manual_fare_table_id : null;
}

/** Get transfer rule between two lines (toLine, fromLine) */
function getTransferRule(faresDb, fromZoneId, toZoneId) {
  const rules = faresDb.prepare(`
    SELECT * FROM transfers_according_to_previous_line
    WHERE line_id = ? AND previous_line_id = ?
    ORDER BY transfer_num
  `).all(toZoneId, fromZoneId);
  return rules;
}

/** Get general transfer discount fare_id for card+time_zone
 * NOTE: transfer_discounts.percent is actually a fare_id reference, not a percentage!
 * 0 = no transfer discount (pay full fare)
 * >0 = fare_id in fares table → look up the actual discounted fare amount
 */
function getGeneralTransferFareId(faresDb, timeZoneId, cardTypeId) {
  const row = faresDb.prepare(`
    SELECT percent FROM transfer_discounts
    WHERE time_zone_id = ? AND card_type_id = ?
    LIMIT 1
  `).get(timeZoneId, cardTypeId);
  return row ? row.percent : 0; // 0 = no discount
}

/** Resolve fare_id to actual fare amount */
function getFareById(faresDb, fareId) {
  if (!fareId) return null;
  const row = faresDb.prepare('SELECT fare FROM fares WHERE fare_id = ? LIMIT 1').get(fareId);
  return row ? row.fare : null;
}

/** Get transfer interval for a time_zone */
function getTransferInterval(faresDb, timeZoneId) {
  const row = faresDb.prepare('SELECT interval FROM transfer_intervals WHERE time_zone_id = ? LIMIT 1').get(timeZoneId);
  return row ? row.interval : 0;
}

/** Get subscription info for a line+card */
function getSubscrInfo(faresDb, lineId, cardTypeId) {
  const row = faresDb.prepare(`
    SELECT ticket, isTransferActive FROM subscr_ticket_taken
    WHERE line_id = ? AND card_type = ?
    LIMIT 1
  `).get(lineId, cardTypeId);
  return row || null;
}

/**
 * Build a structured DB source reference for a specific transfer rule row.
 * Returns the raw row as-is with no interpretation.
 */
function buildSpecificRuleSource(rule, fromZoneId, toZoneId) {
  if (!rule) return null;
  return {
    table: 'transfers_according_to_previous_line',
    query: `WHERE previous_line_id=${fromZoneId} AND line_id=${toZoneId} AND transfer_num=${rule.transfer_num}`,
    rawRow: {
      line_id: rule.line_id,
      previous_line_id: rule.previous_line_id,
      transfer_num: rule.transfer_num,
      interval: rule.interval,
      threshold_time: rule.threshold_time,
      percent: rule.percent,
      flags: rule.flags,
      discount_type: rule.discount_type,
    },
    note: 'Bu değerler yorumlanmadan doğrudan DB\'den okunmaktadır. percent ve discount_type sütunlarının anlamı validatör firmware\'ine bağlıdır.'
  };
}

/**
 * Build a structured DB source reference for the general transfer fare.
 * transfer_discounts.percent aslında fares tablosundaki fare_id referansıdır.
 */
function buildGeneralFareSource(faresDb, timeZoneId, cardTypeId, generalTransferFareId, generalTransferFare) {
  return {
    step1: {
      table: 'transfer_discounts',
      query: `WHERE card_type_id=${cardTypeId} AND time_zone_id=${timeZoneId}`,
      column: 'percent',
      value: generalTransferFareId,
      note: 'Bu sütun fare_id referansı içermektedir (yüzde değil)'
    },
    step2: generalTransferFareId > 0 ? {
      table: 'fares',
      query: `WHERE fare_id=${generalTransferFareId}`,
      column: 'fare',
      value: generalTransferFare,
      valueTL: generalTransferFare !== null ? (generalTransferFare / 100).toFixed(2) + ' ₺' : null
    } : null,
    resolvedFare: generalTransferFare
  };
}

function calcValidatorTransferFare(firstLineFare, secondLineFare, percent, baseTransferFee, discountType = null, cardTypeId = 1) {
  if (cardTypeId === 2) {
    if (percent === 0) return null; // Aktarma yasak
    return 0; // Öğrenci aktarması her zaman ücretsiz
  }
  if (percent === 0) return null; // Aktarma yasak
  if (percent === 10) return 0;   // Ücretsiz aktarma (metro-ring vb.)
  
  if (discountType === '4') {
    // discount_type = 4 ise tamamlayıcı aktarma yok, direkt sabit ücret alınır (baseTransferFee)
    return baseTransferFee ?? 0;
  }
  
  // discount_type = null ise tamamlayıcı aktarma var, fark + base alınır
  const diff = Math.max(0, (secondLineFare ?? 0) - (firstLineFare ?? 0));
  return diff + (baseTransferFee ?? 0);
}

// ─────────────────────────────────────────────────────────
// Main scenario endpoint
// ─────────────────────────────────────────────────────────

/**
 * GET /api/transfer/scenario
 * Query params:
 *   fromLine  - origin line_id (e.g. 140)
 *   toLine    - destination line_id (e.g. 160)
 *   cardType  - card_type_id (default 1 = TAM KART)
 *   hour      - hour 0-23 (default 9)
 *   minute    - minute 0-59 (default 0)
 *   weekday   - 0=Mon..6=Sun (default 1 = Tuesday)
 */
router.get('/scenario', (req, res) => {
  try {
    const faresDb = getFaresDb();
    const linesDb = getLinesDb();

    const fromLineId  = resolveLineId(req.query.fromLine);
    const toLineId    = resolveLineId(req.query.toLine);
    const thirdLineId = resolveLineId(req.query.thirdLine);  // optional 3rd line
    const cardTypeId  = parseInt(req.query.cardType ?? 1);
    const hour        = parseInt(req.query.hour ?? 9);
    const minute      = parseInt(req.query.minute ?? 0);
    const weekday     = parseInt(req.query.weekday ?? 1);

    if (!fromLineId || !toLineId) {
      return res.status(400).json({ error: 'fromLine ve toLine parametreleri gerekli' });
    }

    // ── Line info ──
    const fromLine  = linesDb.prepare('SELECT * FROM lines WHERE line_id = ?').get(fromLineId);
    const toLine    = linesDb.prepare('SELECT * FROM lines WHERE line_id = ?').get(toLineId);
    const thirdLine = thirdLineId ? linesDb.prepare('SELECT * FROM lines WHERE line_id = ?').get(thirdLineId) : null;

    if (!fromLine || !toLine) {
      return res.status(404).json({ error: 'Hat bulunamadı' });
    }
    if (thirdLineId && !thirdLine) {
      return res.status(404).json({ error: '3. hat bulunamadı' });
    }

    // ── Card type info ──
    const cardType = faresDb.prepare('SELECT * FROM card_types WHERE card_type_id = ?').get(cardTypeId);

    // ── Stop types ──
    const fromStopType  = getLineStopType(linesDb, fromLineId);
    const toStopType    = getLineStopType(linesDb, toLineId);
    const thirdStopType = thirdLine ? getLineStopType(linesDb, thirdLineId) : null;

    // ── Time zone resolution ──
    const timeMinutes  = hour * 60 + minute;
    const fromWTTId    = getWeeklyTTId(faresDb, fromLineId);
    const toWTTId      = getWeeklyTTId(faresDb, toLineId);
    const thirdWTTId   = thirdLine ? getWeeklyTTId(faresDb, thirdLineId) : null;
    const fromTZId     = getTimeZoneId(faresDb, fromWTTId, weekday, timeMinutes);
    const toTZId       = getTimeZoneId(faresDb, toWTTId, weekday, timeMinutes);
    const thirdTZId    = thirdLine ? getTimeZoneId(faresDb, thirdWTTId, weekday, timeMinutes) : null;

    // ── Manual fare check ──
    const fromManualFare  = getManualFare(faresDb, fromLineId);
    const toManualFare    = getManualFare(faresDb, toLineId);
    const thirdManualFare = thirdLine ? getManualFare(faresDb, thirdLineId) : null;

    // ── Base fares ──
    const fromFare  = getTicketFare(faresDb, fromStopType, fromTZId, cardTypeId);
    const toFare    = getTicketFare(faresDb, toStopType, toTZId, cardTypeId);
    const thirdFare = thirdLine ? getTicketFare(faresDb, thirdStopType, thirdTZId, cardTypeId) : null;

    // ── Specific transfer rule (1. aktarma: transfer_num=1) ──
    const transferRules   = getTransferRule(faresDb, fromLine.zone_id, toLine.zone_id);
    const hasSpecificRule = transferRules.length > 0;
    // Sadece 1. aktarmayı al (transfer_num=1)
    const firstTransferRules  = transferRules.filter(r => r.transfer_num === 1);
    const primarySpecificRule = firstTransferRules.length > 0;

    // ── 2. aktarma (3. hatta biniş): transfer_num=2, toLine.zone → thirdLine.zone ──
    let secondTransferRules         = [];
    let secondTransferFare          = null;
    let secondTransferFareSource    = null;
    let secondTransferInterval      = 0;
    let secondTransferRule          = null;
    let secondTransferRuleSource    = null;
    let secondTransferNote          = null;
    let secondTransferFormulaBreakdown = null;

    if (thirdLine) {
      secondTransferRules = faresDb.prepare(`
        SELECT * FROM transfers_according_to_previous_line
        WHERE line_id = ? AND previous_line_id = ? AND transfer_num = 2
        ORDER BY transfer_num
      `).all(thirdLine.zone_id, toLine.zone_id);

      const thirdGeneralFareId    = getGeneralTransferFareId(faresDb, thirdTZId, cardTypeId);
      const thirdGeneralFare      = thirdGeneralFareId > 0 ? getFareById(faresDb, thirdGeneralFareId) : null;

      let baseFee2 = 0;
      let secondTransferBaseFareId = 0;
      let secondTransferFormulaType = 'standard';
      const secondTransferFareDiff = Math.max(0, (thirdFare ?? 0) - (toFare ?? 0));

      if (secondTransferRules.length > 0) {
        secondTransferRule       = secondTransferRules[0];
        secondTransferRuleSource = buildSpecificRuleSource(secondTransferRule, toLine.zone_id, thirdLine.zone_id);
        secondTransferInterval   = secondTransferRule.interval;
        
        if (secondTransferRule.discount_type === '4') {
          baseFee2 = getFareById(faresDb, secondTransferRule.percent);
          secondTransferBaseFareId = secondTransferRule.percent;
          secondTransferFormulaType = 'fixed_fee';
        } else {
          secondTransferBaseFareId = getGeneralTransferFareId(faresDb, secondTransferRule.percent, cardTypeId);
          baseFee2 = secondTransferBaseFareId > 0 ? getFareById(faresDb, secondTransferBaseFareId) : 0;
          secondTransferFormulaType = secondTransferRule.percent === 10 ? 'free' : 'complementary';
        }
        
        if (cardTypeId === 2) {
          secondTransferFormulaType = 'free';
        }
        
        secondTransferFare       = calcValidatorTransferFare(toFare ?? 0, thirdFare ?? 0, secondTransferRule.percent, baseFee2, secondTransferRule.discount_type, cardTypeId);
        secondTransferFareSource = buildGeneralFareSource(faresDb, thirdTZId, cardTypeId, secondTransferBaseFareId, baseFee2);
        secondTransferNote       = secondTransferFare !== null
          ? (secondTransferRule.discount_type === '4'
             ? `Sabit aktarma ücreti: ${(baseFee2/100).toFixed(2)}₺ (Tamamlayıcı Yok) | DB: percent=${secondTransferRule.percent} (fare_id)`
             : `Validatör formülü: max(0, ${((thirdFare??0)/100).toFixed(2)}₺ - ${((toFare??0)/100).toFixed(2)}₺) + ${((baseFee2??0)/100).toFixed(2)}₺ (base) = ${(secondTransferFareDiff/100).toFixed(2)}₺ + ${((baseFee2??0)/100).toFixed(2)}₺ = ${(secondTransferFare/100).toFixed(2)}₺ | DB: percent=${secondTransferRule.percent} → transfer_discounts.percent=${secondTransferBaseFareId}`)
          : `Aktarma yasak (percent=0). transfers_according_to_previous_line: previous_line_id=${toLine.zone_id}, line_id=${thirdLine.zone_id}, transfer_num=2`;
        if (secondTransferFare === null) secondTransferFare = thirdFare ?? 0;
      } else {
        // Özel kural yok → genel aktarma formülü
        secondTransferBaseFareId = thirdGeneralFareId;
        baseFee2 = thirdGeneralFare ?? 0;
        secondTransferFormulaType = cardTypeId === 2 ? 'free' : 'standard';

        secondTransferFare       = calcValidatorTransferFare(toFare ?? 0, thirdFare ?? 0, 1, thirdGeneralFare, null, cardTypeId);
        secondTransferFareSource = buildGeneralFareSource(faresDb, thirdTZId, cardTypeId, thirdGeneralFareId, thirdGeneralFare);
        secondTransferInterval   = getTransferInterval(faresDb, thirdTZId);
        secondTransferNote       = thirdGeneralFare !== null
          ? `Validatör formülü: max(0, ${((thirdFare??0)/100).toFixed(2)}₺ - ${((toFare??0)/100).toFixed(2)}₺) + ${((thirdGeneralFare??0)/100).toFixed(2)}₺ (base) = ${(secondTransferFareDiff/100).toFixed(2)}₺ + ${((thirdGeneralFare??0)/100).toFixed(2)}₺ = ${((secondTransferFare??0)/100).toFixed(2)}₺· [Özel kural yok; transfer_discounts fare_id=${thirdGeneralFareId}]`
          : `DB'de aktarma indirimi yok. 3. hat tam ücret: ${((thirdFare??0)/100).toFixed(2)}₺`;
        if (secondTransferFare === null) secondTransferFare = thirdFare ?? 0;
      }

      secondTransferFormulaBreakdown = {
        type: secondTransferFormulaType,
        formula: (() => {
          if (secondTransferFormulaType === 'free') return '0.00 ₺ (Ücretsiz Aktarma)';
          if (secondTransferFormulaType === 'fixed_fee') return 'sabit_ücret (Tamamlayıcı Yok)';
          if (secondTransferFormulaType === 'complementary') return 'max(0, 2.hat - 1.hat) + base';
          return 'max(0, 2.hat - 1.hat) + base';
        })(),
        firstFare: toFare,
        secondFare: thirdFare,
        diff: secondTransferFareDiff,
        base: baseFee2,
        baseFareId: secondTransferBaseFareId,
        result: secondTransferFare,
        percentUsed: secondTransferRule ? secondTransferRule.percent : 1,
        specificRule: secondTransferRules.length > 0,
      };
    }

    // ── General transfer discount (fallback) ──
    // transfer_discounts.percent is a fare_id reference!
    const generalTransferFareId = getGeneralTransferFareId(faresDb, toTZId, cardTypeId);
    const generalTransferFare   = generalTransferFareId > 0 ? getFareById(faresDb, generalTransferFareId) : null;
    const transferWindowMin     = getTransferInterval(faresDb, toTZId);
    const hasGeneralDiscount = generalTransferFare !== null;

    // ── Subscription info ──
    const fromSubscr = getSubscrInfo(faresDb, fromLineId, cardTypeId);
    const toSubscr   = getSubscrInfo(faresDb, toLineId, cardTypeId);

    // ── Card parameters (subscr_transfer_type) ──
    const cardParams = faresDb.prepare('SELECT * FROM card_types_parameters WHERE card_type = ? LIMIT 1').get(cardTypeId);
    const subscrTransferType = cardParams?.subscr_transfer_type ?? 0;
    const fromTransferActive = fromSubscr ? fromSubscr.isTransferActive : null;
    const toTransferActive   = toSubscr   ? toSubscr.isTransferActive   : null;
    // If a subscr record exists and isTransferActive=0 for TO line → signal possible incomplete data
    const transferActiveWarning = (toSubscr && toSubscr.isTransferActive === 0)
      ? 'Bu hat için bu kart tipinin aktarma kuralı DB\'de devre dışı (isTransferActive=0). Gerçek validatör davranışı farklı olabilir.'
      : null;

    const allCardTypes = faresDb.prepare('SELECT * FROM card_types ORDER BY card_type_id').all()
      .filter(ct => isNamedCard(ct.description));
    const cardTypeComparison = allCardTypes.map(ct => {
      const ctFromTZ   = getTimeZoneId(faresDb, fromWTTId, weekday, timeMinutes);
      const ctToTZ     = getTimeZoneId(faresDb, toWTTId, weekday, timeMinutes);
      const ctFromFare = getTicketFare(faresDb, fromStopType, ctFromTZ, ct.card_type_id);
      const ctToFare   = getTicketFare(faresDb, toStopType, ctToTZ, ct.card_type_id);

      const ctGeneralFareId  = getGeneralTransferFareId(faresDb, ctToTZ, ct.card_type_id);
      const ctGeneralFare    = ctGeneralFareId > 0 ? getFareById(faresDb, ctGeneralFareId) : null;

      let ctTransferFare, ctTransferNote, ctInterval;

      if (primarySpecificRule) {
        const rule = firstTransferRules[0];
        let ctBaseFee;
        let ctBaseFareId;
        if (rule.discount_type === '4') {
          ctBaseFee = getFareById(faresDb, rule.percent);
          ctBaseFareId = rule.percent;
        } else {
          ctBaseFareId = getGeneralTransferFareId(faresDb, rule.percent, ct.card_type_id);
          ctBaseFee = ctBaseFareId > 0 ? getFareById(faresDb, ctBaseFareId) : 0;
        }
        
        ctTransferFare = calcValidatorTransferFare(ctFromFare ?? 0, ctToFare ?? 0, rule.percent, ctBaseFee, rule.discount_type, ct.card_type_id);
        const diff = Math.max(0, (ctToFare ?? 0) - (ctFromFare ?? 0));
        ctTransferNote = ctTransferFare !== null
          ? (rule.discount_type === '4'
             ? `Sabit ücret: ${(ctBaseFee/100).toFixed(2)}₺ (Tamamlayıcı Yok)`
             : `max(0,${((ctToFare??0)/100).toFixed(2)}-${((ctFromFare??0)/100).toFixed(2)}) + ${((ctBaseFee??0)/100).toFixed(2)} = ${(diff/100).toFixed(2)}+${((ctBaseFee??0)/100).toFixed(2)} = ${(ctTransferFare/100).toFixed(2)}₺ [percent=${rule.percent}]`)
          : `Aktarma yasak (percent=0)`;
        ctInterval = rule.interval;
        if (ctTransferFare === null) ctTransferFare = ctToFare ?? 0;
      } else {

        ctTransferFare = calcValidatorTransferFare(ctFromFare ?? 0, ctToFare ?? 0, 1, ctGeneralFare, null, ct.card_type_id);
        const diff = Math.max(0, (ctToFare ?? 0) - (ctFromFare ?? 0));
        ctTransferNote = ctGeneralFare !== null
          ? `max(0,${((ctToFare??0)/100).toFixed(2)}-${((ctFromFare??0)/100).toFixed(2)}) + ${((ctGeneralFare??0)/100).toFixed(2)} = ${(diff/100).toFixed(2)}+${((ctGeneralFare??0)/100).toFixed(2)} = ${((ctTransferFare??0)/100).toFixed(2)}₺ [genel fare_id=${ctGeneralFareId}]`
          : 'DB\'de aktarma kuralı yok';
        ctInterval = 0;
        if (ctTransferFare === null) ctTransferFare = ctToFare ?? 0;
      }

      return {
        cardTypeId: ct.card_type_id,
        description: formatCardLabel(ct.description, ct.card_type_id),
        fromFare: ctFromFare,
        toFare: ctToFare,
        transferFare: ctTransferFare,
        totalFare: ctTransferFare !== null ? (ctFromFare ?? 0) + ctTransferFare : null,
        transferNote: ctTransferNote,
        intervalMinutes: ctInterval,
      };
    });


    let primaryTransferFare;
    let primaryTransferFareSource = null;
    let primaryInterval;
    let primaryRule = null;
    let primaryTransferNote;
    let primaryFareDiff;
    let primaryBaseFee = 0;
    let primaryBaseFareId = 0;
    let formulaType = 'standard';

    if (primarySpecificRule) {
      primaryRule    = firstTransferRules[0];
      primaryInterval = primaryRule.interval;
      
      if (primaryRule.discount_type === '4') {
        primaryBaseFee = getFareById(faresDb, primaryRule.percent);
        primaryBaseFareId = primaryRule.percent;
        formulaType = 'fixed_fee';
        primaryTransferFareSource = {
          step1: {
            table: 'transfers_according_to_previous_line',
            query: `WHERE previous_line_id=${fromLine.zone_id} AND line_id=${toLine.zone_id} AND transfer_num=1`,
            column: 'percent',
            value: primaryRule.percent,
            note: 'discount_type = 4 olduğu için percent sütunu doğrudan fare_id olarak kullanılmıştır.'
          },
          step2: {
            table: 'fares',
            query: `WHERE fare_id=${primaryRule.percent}`,
            column: 'fare',
            value: primaryBaseFee,
            valueTL: (primaryBaseFee / 100).toFixed(2) + ' ₺'
          },
          resolvedFare: primaryBaseFee
        };
      } else {
        primaryBaseFareId = getGeneralTransferFareId(faresDb, primaryRule.percent, cardTypeId);
        primaryBaseFee = primaryBaseFareId > 0 ? getFareById(faresDb, primaryBaseFareId) : 0;
        formulaType = primaryRule.percent === 10 ? 'free' : 'complementary';
        primaryTransferFareSource = buildGeneralFareSource(faresDb, primaryRule.percent, cardTypeId, primaryBaseFareId, primaryBaseFee);
      }
      
      if (cardTypeId === 2) {
        formulaType = 'free'; // 
      }
      
      primaryTransferFare  = calcValidatorTransferFare(fromFare ?? 0, toFare ?? 0, primaryRule.percent, primaryBaseFee, primaryRule.discount_type, cardTypeId);
      primaryFareDiff      = Math.max(0, (toFare ?? 0) - (fromFare ?? 0));
      
      if (primaryTransferFare !== null) {
        primaryTransferNote = primaryRule.discount_type === '4'
          ? `Sabit aktarma ücreti: ${(primaryBaseFee/100).toFixed(2)}₺ (Tamamlayıcı Yok) | DB: percent=${primaryRule.percent} (fare_id)`
          : `Validatör formülü: max(0, ${((toFare??0)/100).toFixed(2)}₺ - ${((fromFare??0)/100).toFixed(2)}₺) + ${((primaryBaseFee??0)/100).toFixed(2)}₺ (base) = ${(primaryFareDiff/100).toFixed(2)}₺ + ${((primaryBaseFee??0)/100).toFixed(2)}₺ = ${(primaryTransferFare/100).toFixed(2)}₺ | DB: percent=${primaryRule.percent} → transfer_discounts.percent=${primaryBaseFareId}`;
      } else {
        primaryTransferNote = `Aktarma yasak (percent=0). DB: transfers_according_to_previous_line·previous_line_id=${fromLine.zone_id}·line_id=${toLine.zone_id}·percent=0`;
        primaryTransferFare = toFare ?? 0; 
      }
    } else {

      primaryBaseFee            = generalTransferFare ?? 0;
      primaryBaseFareId         = generalTransferFareId;
      formulaType               = cardTypeId === 2 ? 'free' : 'standard';
      primaryTransferFare       = calcValidatorTransferFare(fromFare ?? 0, toFare ?? 0, 1, generalTransferFare, null, cardTypeId);
      primaryFareDiff           = Math.max(0, (toFare ?? 0) - (fromFare ?? 0));
      primaryTransferFareSource = buildGeneralFareSource(faresDb, toTZId, cardTypeId, generalTransferFareId, generalTransferFare);
      primaryInterval           = 0;
      if (generalTransferFare !== null) {
        primaryTransferNote = `Validatör formülü: max(0, ${((toFare??0)/100).toFixed(2)}₺ - ${((fromFare??0)/100).toFixed(2)}₺) + ${((generalTransferFare??0)/100).toFixed(2)}₺ (base) = ${(primaryFareDiff/100).toFixed(2)}₺ + ${((generalTransferFare??0)/100).toFixed(2)}₺ = ${((primaryTransferFare??0)/100).toFixed(2)}₺ | DB: özel kural yok; transfer_discounts·card_type_id=${cardTypeId}·time_zone_id=${toTZId}·percent=${generalTransferFareId} → fares·fare_id=${generalTransferFareId} = ${((generalTransferFare??0)/100).toFixed(2)}₺`;
      } else {
        primaryTransferNote = `DB'de aktarma indirimi yok (transfer_discounts.percent=0). 2. hat tam ücret olarak uygulanır.`;
      }
      if (primaryTransferFare === null) primaryTransferFare = toFare ?? 0;
    }

    res.json({
      // Lines
      fromLine:  { ...fromLine,  displayId: formatLineId(fromLine.line_id),  stopType: fromStopType,  hasManualFare: !!fromManualFare },
      toLine:    { ...toLine,    displayId: formatLineId(toLine.line_id),    stopType: toStopType,    hasManualFare: !!toManualFare },
      thirdLine: thirdLine ? { ...thirdLine, displayId: formatLineId(thirdLine.line_id), stopType: thirdStopType, hasManualFare: !!thirdManualFare } : null,

      // Card
      cardType: { cardTypeId, description: cardType?.description?.trim() || `KT_${cardTypeId}` },

      // Time context
      timeContext: {
        hour, minute, weekday,
        timeMinutes,
        weekdayName: ['Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi','Pazar'][weekday] || '?',
        weekdayNameEn: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][weekday] || '?',
        fromTimeZoneId: fromTZId,
        toTimeZoneId: toTZId,
        thirdTimeZoneId: thirdTZId,
      },

      // Base fares
      fromFare,
      toFare,
      thirdFare,

      // ── 1. aktarma (fromLine → toLine) ──
      hasSpecificRule: primarySpecificRule,
      // Ham DB satırı
      transferRule: primaryRule ? buildSpecificRuleSource(primaryRule, fromLine.zone_id, toLine.zone_id) : null,
      // Validatör formülüyle hesaplanan ücret
      transferFare: primaryTransferFare,
      transferFareDiff: primaryFareDiff ?? 0,        // max(0, 2.hat - 1.hat) kısmı
      transferFareBase: primaryBaseFee,                // base transfer fee (DB'den)
      transferFareSource: primaryTransferFareSource,
      transferNote: primaryTransferNote,
      intervalMinutes: primaryInterval,
      // Formül açıklaması — UI'da göstermek için
      formulaBreakdown: {
        type: formulaType,
        formula: (() => {
          if (formulaType === 'free') return '0.00 ₺ (Ücretsiz Aktarma)';
          if (formulaType === 'fixed_fee') return 'sabit_ücret (Tamamlayıcı Yok)';
          if (formulaType === 'complementary') return 'max(0, 2.hat - 1.hat) + base';
          return 'max(0, 2.hat - 1.hat) + base';
        })(),
        firstFare: fromFare,
        secondFare: toFare,
        diff: primaryFareDiff ?? 0,
        base: primaryBaseFee,
        baseFareId: primaryBaseFareId,
        result: primaryTransferFare,
        percentUsed: primaryRule ? primaryRule.percent : 1,
        specificRule: !!primarySpecificRule,
      },

      // ── 2. aktarma (toLine → thirdLine) — sadece thirdLine seçildiyse ──
      secondTransfer: thirdLine ? {
        hasSpecificRule: secondTransferRules.length > 0,
        transferRule: secondTransferRuleSource,
        transferFare: secondTransferFare,
        transferFareDiff: Math.max(0, (thirdFare ?? 0) - (toFare ?? 0)),
        transferFareBase: (() => { const id = getGeneralTransferFareId(faresDb, thirdTZId, cardTypeId); return id > 0 ? getFareById(faresDb, id) : null; })(),
        transferFareSource: secondTransferFareSource,
        transferNote: secondTransferNote,
        thirdFare,
        intervalMinutes: secondTransferInterval,
        formulaBreakdown: secondTransferFormulaBreakdown,
      } : null,

      // Toplam tutar
      totalFare: (fromFare ?? 0) + (primaryTransferFare ?? 0) + (thirdLine ? (secondTransferFare ?? 0) : 0),

      // Genel aktarma bilgisi (her zaman döndürülür, referans amaçlı)
      generalTransferFare: {
        fareId: generalTransferFareId,
        fare: generalTransferFare,
        source: buildGeneralFareSource(faresDb, toTZId, cardTypeId, generalTransferFareId, generalTransferFare),
        windowMinutes: transferWindowMin,
      },

      // Ham özel kural listesi (tüm transfer_num'lar) — yorumsuz
      allTransferRules: transferRules.map(r => ({
        table: 'transfers_according_to_previous_line',
        rawRow: r,
      })),

      // Abonelik
      fromSubscription: fromSubscr,
      toSubscription: toSubscr,
      fromTransferActive,
      toTransferActive,

      // DB uyarıları
      transferActiveWarning,
      dataWarning: transferActiveWarning
        ? 'ℹ️ Bu hat-kart kombinasyonu için aktarma kaydı DB\'de mevcut ancak devre dışı (isTransferActive=0). Validatördeki gerçek davranış bu DB\'de tam olarak yansıtılmıyor olabilir.'
        : null,

      // Kart tipi karşılaştırması
      cardTypeComparison,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/transfer/lines-search?q=&limit=20
 * Fuzzy line search for autocomplete
 */
router.get('/lines-search', (req, res) => {
  try {
    const linesDb = getLinesDb();
    const q = req.query.q || '';
    const limit = parseInt(req.query.limit) || 20;

    const lines = linesDb.prepare(`
      SELECT line_id, name, zone_id
      FROM lines
      WHERE name LIKE ? OR CAST(line_id AS TEXT) LIKE ?
      ORDER BY
        CASE WHEN line_id <= 999 THEN line_id ELSE line_id / 10 END,
        CASE WHEN line_id <= 999 THEN 0 ELSE line_id % 10 END
      LIMIT ?
    `).all(`%${q}%`, `%${q}%`, limit);

    res.json(lines.map(l => ({
      ...l,
      displayId: formatLineId(l.line_id)
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/transfer/card-types
 * All card types for selector
 */
router.get('/card-types', (req, res) => {
  try {
    const faresDb = getFaresDb();
    const types = faresDb.prepare(`
      SELECT ct.card_type_id, ct.description,
        COUNT(DISTINCT tf.stop_type) as fareRules
      FROM card_types ct
      LEFT JOIN ticket_fares tf ON tf.card_type_id = ct.card_type_id
      GROUP BY ct.card_type_id
      ORDER BY ct.card_type_id
    `).all();
    res.json(
      types
        .filter(t => isNamedCard(t.description))
        .map(t => ({
          ...t,
          description: formatCardLabel(t.description, t.card_type_id)
        }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────
// Batch Simulation Helpers
// ─────────────────────────────────────────────────────────

function simulateAllZoneCombos(faresDb, linesDb, cardTypeId, timeZoneId, generalTransferFare) {
  // 1. Get stop_type count by zone
  const zoneStopTypes = {};
  const zoneSampleLines = {};

  const lines = linesDb.prepare('SELECT line_id, name, zone_id FROM lines').all();

  // Get most common stop type for all lines
  const lineStopTypes = {};
  linesDb.prepare('SELECT line_id, stop_type, COUNT(*) as cnt FROM line_stops GROUP BY line_id, stop_type').all().forEach(row => {
    if (!lineStopTypes[row.line_id] || row.cnt > lineStopTypes[row.line_id].cnt) {
      lineStopTypes[row.line_id] = row.stop_type;
    }
  });

  // Group stop types and lines by zone
  lines.forEach(l => {
    const st = lineStopTypes[l.line_id] || 1;
    if (!zoneStopTypes[l.zone_id]) {
      zoneStopTypes[l.zone_id] = {};
    }
    zoneStopTypes[l.zone_id][st] = (zoneStopTypes[l.zone_id][st] || 0) + 1;
    
    if (!zoneSampleLines[l.zone_id]) zoneSampleLines[l.zone_id] = [];
    if (zoneSampleLines[l.zone_id].length < 3) {
      zoneSampleLines[l.zone_id].push(`${formatLineId(l.line_id)} (${l.name})`);
    }
  });

  // Select the most common stop type for each zone
  const primaryZoneStopType = {};
  for (const zoneId in zoneStopTypes) {
    let bestSt = 1;
    let maxCount = 0;
    for (const st in zoneStopTypes[zoneId]) {
      if (zoneStopTypes[zoneId][st] > maxCount) {
        maxCount = zoneStopTypes[zoneId][st];
        bestSt = parseInt(st);
      }
    }
    primaryZoneStopType[zoneId] = bestSt;
  }

  // Pre-query fares for this card_type_id and time_zone_id
  const faresCache = {};
  faresDb.prepare('SELECT stop_type, fare FROM ticket_fares tf JOIN fares f ON f.fare_id = tf.fare_id WHERE tf.card_type_id = ? AND tf.time_zone_id = ?').all(cardTypeId, timeZoneId).forEach(row => {
    faresCache[row.stop_type] = row.fare;
  });

  // Helper to interpret transfer type
  function interpretLocalTransferType(percent, discountType) {
    if (percent === 0) return { type: 'NO_TRANSFER', label: 'Aktarma Yok', color: '#ff6b6b' };
    if (percent === 10) return { type: 'FREE', label: 'Ücretsiz', color: '#00d4aa' };
    if (discountType === '4') return { type: 'FIXED_FEE', label: 'Sabit Ücret', color: '#f5a623' };
    return { type: 'GENERAL_DISCOUNT', label: 'Genel İndirim', color: '#4f7cff' };
  }

  // Helper to calculate transfer fare
  function calcLocalTransferFare(firstLineFare, secondLineFare, transferType, percent, discountType) {
    if (cardTypeId === 2) {
      if (percent === 0) return secondLineFare; // Aktarma yasak
      return 0; // Öğrenci aktarması ücretsiz
    }
    if (percent === 0) return secondLineFare;
    if (percent === 10) return 0; // Ücretsiz aktarma
    
    if (transferType === 'FIXED_FEE') {
      const f = getFareById(faresDb, percent);
      return f !== null ? f : secondLineFare;
    }
    
    // Complementary transfer (discount_type is null)
    // base fee is resolved from transfer_discounts using percent as time_zone_id
    const baseFareId = getGeneralTransferFareId(faresDb, percent, cardTypeId);
    const baseFee = baseFareId > 0 ? getFareById(faresDb, baseFareId) : 0;
    
    const diff = Math.max(0, secondLineFare - firstLineFare);
    return diff + baseFee;
  }

  // Find zone transitions
  const t1Rules = faresDb.prepare("SELECT previous_line_id as fromZone, line_id as toZone, percent, discount_type, interval FROM transfers_according_to_previous_line WHERE transfer_num = 1").all();
  const t2Rules = faresDb.prepare("SELECT previous_line_id as fromZone, line_id as toZone, percent, discount_type, interval FROM transfers_according_to_previous_line WHERE transfer_num = 2").all();

  const t2Index = {};
  t2Rules.forEach(r => {
    if (!t2Index[r.fromZone]) t2Index[r.fromZone] = [];
    t2Index[r.fromZone].push(r);
  });

  const simulatedCombos = [];

  t1Rules.forEach(r1 => {
    const zoneA = r1.fromZone;
    const zoneB = r1.toZone;
    const possibleLeg2 = t2Index[zoneB];
    
    if (possibleLeg2) {
      possibleLeg2.forEach(r2 => {
        const zoneC = r2.toZone;
        
        const stA = primaryZoneStopType[zoneA] || 1;
        const stB = primaryZoneStopType[zoneB] || 1;
        const stC = primaryZoneStopType[zoneC] || 1;
        
        // Base fares (fallback to 3500 if not found)
        const fareA = faresCache[stA] !== undefined ? faresCache[stA] : 3500;
        const fareB = faresCache[stB] !== undefined ? faresCache[stB] : 3500;
        const fareC = faresCache[stC] !== undefined ? faresCache[stC] : 3500;
        
        // 1st transfer
        const tt1 = interpretLocalTransferType(r1.percent, r1.discount_type);
        const tf1 = calcLocalTransferFare(fareA, fareB, tt1.type, r1.percent, r1.discount_type);
        
        // 2nd transfer
        const tt2 = interpretLocalTransferType(r2.percent, r2.discount_type);
        const tf2 = calcLocalTransferFare(fareB, fareC, tt2.type, r2.percent, r2.discount_type);
        
        const total = fareA + tf1 + tf2;
        const savings = (fareA + fareB + fareC) - total;
        
        const sampleA = zoneSampleLines[zoneA]?.join(' | ') || `Bölge ${zoneA}`;
        const sampleB = zoneSampleLines[zoneB]?.join(' | ') || `Bölge ${zoneB}`;
        const sampleC = zoneSampleLines[zoneC]?.join(' | ') || `Bölge ${zoneC}`;

        const diffApplied1 = tf1 > generalTransferFare && tt1.type === 'GENERAL_DISCOUNT';
        const diffApplied2 = tf2 > generalTransferFare && tt2.type === 'GENERAL_DISCOUNT';
        
        simulatedCombos.push({
          zoneA, zoneB, zoneC,
          fareA, fareB, fareC,
          tf1, tf2, total, savings,
          rule1: tt1.label, rule2: tt2.label,
          rule1Color: tt1.color, rule2Color: tt2.color,
          interval1: r1.interval, interval2: r2.interval,
          sampleA, sampleB, sampleC,
          diffApplied1, diffApplied2,
          hasDiffApplied: diffApplied1 || diffApplied2,
          hasNoRule: tt1.type === 'NO_RULE' || tt2.type === 'NO_RULE'
        });
      });
    }
  });

  return simulatedCombos;
}

/**
 * GET /api/transfer/three-leg-combinations
 * Query params:
 *   q        - general search term (optional)
 *   page     - page number (default 1)
 *   limit    - items per page (default 20)
 *   cardType - card_type_id (default 1)
 *   hour     - hour 0-23 (default 9)
 *   minute   - minute 0-59 (default 0)
 *   weekday  - 0=Mon..6=Sun (default 1)
 *   filter   - filter type: 'all', 'diff', 'free', 'noRule'
 */
router.get('/three-leg-combinations', (req, res) => {
  try {
    const faresDb = getFaresDb();
    const linesDb = getLinesDb();

    const q = (req.query.q || '').trim();
    const page = parseInt(req.query.page ?? 1);
    const limit = parseInt(req.query.limit ?? 20);
    const offset = (page - 1) * limit;

    const cardTypeId = parseInt(req.query.cardType ?? 1);
    const hour = parseInt(req.query.hour ?? 9);
    const minute = parseInt(req.query.minute ?? 0);
    const weekday = parseInt(req.query.weekday ?? 1);
    const filter = req.query.filter || 'all'; // all, diff, free, noRule

    const timeMinutes = hour * 60 + minute;
    const timeZoneId = getTimeZoneId(faresDb, 1, weekday, timeMinutes) || 3;
    const generalTransferFareId = getGeneralTransferFareId(faresDb, timeZoneId, cardTypeId);
    const generalTransferFare = generalTransferFareId > 0 ? getFareById(faresDb, generalTransferFareId) : 0;

    // Simulate all combinations
    const allCombos = simulateAllZoneCombos(faresDb, linesDb, cardTypeId, timeZoneId, generalTransferFare);

    // Apply filter and search
    let filtered = allCombos;

    if (filter === 'diff') {
      filtered = filtered.filter(c => c.hasDiffApplied);
    } else if (filter === 'free') {
      filtered = filtered.filter(c => c.tf1 === 0 || c.tf2 === 0);
    } else if (filter === 'noRule') {
      filtered = filtered.filter(c => c.hasNoRule);
    }

    if (q) {
      const qLower = q.toLowerCase();
      filtered = filtered.filter(c => {
        const searchStr = `${c.zoneA} ${c.zoneB} ${c.zoneC} ${c.sampleA} ${c.sampleB} ${c.sampleC} ${c.rule1} ${c.rule2}`.toLowerCase();
        return qLower.split(' ').every(word => searchStr.includes(word));
      });
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    res.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      results: paginated
    });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/transfer/export-simulated-csv
 * Live CSV export of simulated zone combination fares.
 * Query params:
 *   cardType - card_type_id (default 1)
 *   hour     - hour 0-23 (default 9)
 *   minute   - minute 0-59 (default 0)
 *   weekday  - 0=Mon..6=Sun (default 1)
 */
router.get('/export-simulated-csv', (req, res) => {
  try {
    const faresDb = getFaresDb();
    const linesDb = getLinesDb();

    const cardTypeId = parseInt(req.query.cardType ?? 1);
    const hour = parseInt(req.query.hour ?? 9);
    const minute = parseInt(req.query.minute ?? 0);
    const weekday = parseInt(req.query.weekday ?? 1);

    const timeMinutes = hour * 60 + minute;
    const timeZoneId = getTimeZoneId(faresDb, 1, weekday, timeMinutes) || 3;
    const generalTransferFareId = getGeneralTransferFareId(faresDb, timeZoneId, cardTypeId);
    const generalTransferFare = generalTransferFareId > 0 ? getFareById(faresDb, generalTransferFareId) : 0;

    // Simulate all combinations
    const allCombos = simulateAllZoneCombos(faresDb, linesDb, cardTypeId, timeZoneId, generalTransferFare);

    // Format as CSV
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=three_leg_simulated_fares.csv');

    // Write UTF-8 BOM for proper Turkish characters in Excel
    res.write('\uFEFF');

    // Headers
    const headers = [
      '1. Hat Bolgesi (Zone A)', 'Ornek Hatlar A', '1. Binis Ucreti (TL)',
      '1. Aktarma Kurali', 'Bekleme Suresi 1 (dk)', '2. Binis (1. Aktarma) Ucreti (TL)',
      'Metro Bolgesi (Zone B)', 'Ornek Hatlar B', '2. Aktarma Kurali',
      'Bekleme Suresi 2 (dk)', '3. Binis (2. Aktarma) Ucreti (TL)',
      '3. Hat Bolgesi (Zone C)', 'Ornek Hatlar C',
      'Toplam Ucret (TL)', 'Toplam Tasarruf (TL)', 'Ucret Farki Alindi Mi?'
    ];
    res.write(headers.join(';') + '\n');

    allCombos.forEach(c => {
      const row = [
        `Zone ${c.zoneA}`, `"${c.sampleA.replace(/"/g, '""')}"`, (c.fareA / 100).toFixed(2),
        c.rule1, `${c.interval1} dk`, (c.tf1 / 100).toFixed(2),
        `Zone ${c.zoneB}`, `"${c.sampleB.replace(/"/g, '""')}"`, c.rule2,
        `${c.interval2} dk`, (c.tf2 / 100).toFixed(2),
        `Zone ${c.zoneC}`, `"${c.sampleC.replace(/"/g, '""')}"`,
        (c.total / 100).toFixed(2), (c.savings / 100).toFixed(2),
        c.hasDiffApplied ? 'EVET' : 'HAYIR'
      ];
      res.write(row.join(';') + '\n');
    });

    res.end();

  } catch(err) {
    res.status(500).send(`Error generating CSV: ${err.message}`);
  }
});

module.exports = router;
