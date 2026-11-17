// ── main: the exports for Node and the start-up guard ──
// Owns nothing but the hand-over: under Node (module.exports exists) loading
// only exports the functions and tables for the tests (pksInit and
// pksRuntime among them, so a test can run the page on a stub document);
// in a browser the page starts once the document is parsed.  Uses every
// earlier part.

function pksConstantsObject() {
  return {
    W: PKS_W, H: PKS_H, FIELD_X: PKS_FIELD_X, FIELD_Y: PKS_FIELD_Y, CELL: PKS_CELL,
    COLS: PKS_COLS, LANES: PKS_LANES, RATE: PKS_RATE, STEP: PKS_STEP, MAX_FRAME: PKS_MAX_FRAME,
    SPAWN_X: PKS_SPAWN_X, FLOOR_END: PKS_FLOOR_END, SHOT_SPEED: PKS_SHOT_SPEED, SHOT_END: PKS_SHOT_END,
    BODY: PKS_BODY, REACH: PKS_REACH, START_CYCLES: PKS_START_CYCLES, BROWNOUT_CYCLES: PKS_BROWNOUT_CYCLES,
    TRICKLE: PKS_TRICKLE, TRICKLE_EVERY: PKS_TRICKLE_EVERY, SURGE_WARN: PKS_SURGE_WARN,
    FLASH: PKS_FLASH, FIRE_ANIM: PKS_FIRE_ANIM, BOSS_CAP: PKS_BOSS_CAP, BOSS_FREEZE: PKS_BOSS_FREEZE,
    BOSS_PUSH: PKS_BOSS_PUSH, BOSS_BREAKER: PKS_BOSS_BREAKER, RANSOM_CAST: PKS_RANSOM_CAST,
    RANSOM_OFF: PKS_RANSOM_OFF, UNCLOAK_X: PKS_UNCLOAK_X, DRAIN_TICK: PKS_DRAIN_TICK,
    LEAP_TIME: PKS_LEAP_TIME, LEVELS: PKS_LEVELS,
    SLIDE_TIME: PKS_SLIDE_TIME, FROZEN_LEVELS: PKS_FROZEN_LEVELS, FROZEN_DEFENDERS: PKS_FROZEN_DEFENDERS,
    EXPRESS: PKS_EXPRESS, HOT_DPS: PKS_HOT_DPS, RAIL: PKS_RAIL, TUNNEL_COL: PKS_TUNNEL_COL,
    TUNNEL_EVERY: PKS_TUNNEL_EVERY, SHIMMER: PKS_SHIMMER, LATE_FOG: PKS_LATE_FOG, ROOT_SPEED: PKS_ROOT_SPEED,
    BLACKOUT_EVERY: PKS_BLACKOUT.every, BLACKOUT_LENGTH: PKS_BLACKOUT.length, BLACKOUT_WARN: PKS_BLACKOUT.warn,
    BLACKOUT_SIGHT: PKS_BLACKOUT.sight, UPKEEP_COST: PKS_UPKEEP.cost, UPKEEP_EVERY: PKS_UPKEEP.every,
    OUTAGE_EVERY: PKS_OUTAGE.every, OUTAGE_LENGTH: PKS_OUTAGE.length, OUTAGE_WARN: PKS_OUTAGE.warn,
    OVERTIME: PKS_OVERTIME
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    pksConstants: pksConstantsObject(),
    pksDefenders: PKS_DEFENDERS,
    pksDefender: PKS_DEF,
    pksEnemies: PKS_ENEMIES,
    pksEnemy: PKS_ENEMY,
    pksBossTiers: PKS_BOSS_TIERS,
    pksZones: PKS_ZONES,
    pksLevelRows: PKS_LEVEL_ROWS,
    pksLevel: pksLevel,
    pksLevelUnlock: pksLevelUnlock,
    pksShooterKinds: PKS_SHOOTER_KINDS,
    pksNoRules: pksNoRules,
    pksRuleOrder: PKS_RULE_ORDER,
    pksSlots: pksSlots,
    pksUnlockedDefenders: pksUnlockedDefenders,
    pksNewSim: pksNewSim,
    pksStep: pksStep,
    pksCanPlace: pksCanPlace,
    pksPlace: pksPlace,
    pksRemove: pksRemove,
    pksStars: pksStars,
    pksSpawnEnemy: pksSpawnEnemy,
    pksRand: pksRand,
    pksPalette: PKS_PALETTE,
    pksSprites: PKS_SPRITES,
    pksBuildAtlas: pksBuildAtlas,
    pksDecom: PKS_DECOM,
    pksNewView: pksNewView,
    pksViewEvents: pksViewEvents,
    pksViewStep: pksViewStep,
    pksRender: pksRender,
    pksCellAt: pksCellAt,
    pksCellRect: pksCellRect,
    pksIconName: pksIconName,
    pksDrawIcon: pksDrawIcon,
    pksFxMax: PKS_FX_MAX,
    pksSaveKey: PKS_SAVE_KEY,
    pksNewSave: pksNewSave,
    pksParseSave: pksParseSave,
    pksSerialize: pksSerialize,
    pksMergeSaves: pksMergeSaves,
    pksReadSave: pksReadSave,
    pksWriteSave: pksWriteSave,
    pksHighestWon: pksHighestWon,
    pksOwnedDefenders: pksOwnedDefenders,
    pksRecordWin: pksRecordWin,
    pksRecordMet: pksRecordMet,
    pksLoadoutFor: pksLoadoutFor,
    pksRunKey: PKS_RUN_KEY,
    pksRunEvery: PKS_RUN_EVERY,
    pksRunHash: pksRunHash,
    pksRunText: pksRunText,
    pksParseRun: pksParseRun,
    pksReadRun: pksReadRun,
    pksPutRun: pksPutRun,
    pksDropRun: pksDropRun,
    pksHueShift: pksHueShift,
    pksRuleNames: PKS_RULE_NAMES,
    pksRuleText: pksRuleText,
    pksRuleClock: pksRuleClock,
    pksEventUi: PKS_EVENT_UI,
    pksRuleEventUi: PKS_RULE_EVENT_UI,
    pksClock: pksClock,
    pksRefusalText: pksRefusalText,
    pksKeyAction: pksKeyAction,
    pksCardShorts: PKS_CARD_SHORTS,
    pksFitScale: pksFitScale,
    pksPageScale: pksPageScale,
    pksPageLayout: pksPageLayout,
    pksFitLayout: pksFitLayout,
    pksFrameLayout: pksFrameLayout,
    pksInit: pksInit,
    pksRuntime: pksRuntime
  };
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', pksInit);
} else {
  pksInit();
}
