// ── levels: CDA_LEVELS (the episode's levels in order) and cdaLevelCarry ──
// Owns CDA_LEVELS and cdaLevelCarry.  Uses tables (CDA_PLAYER), map
// (cdaParseLevel) and the level parts (levels-a, levels-b, levels-c: the raw
// level objects).
//
// CDA_LEVELS holds the raw level objects (the map part's format); the page
// parses one with cdaParseLevel when it starts it.  Every level has a kit:
// the tools and ammo a player has at the least on entering it.
//
// cdaLevelCarry(index, carry): the carried state (sim's carry format) to
// start level `index` with.  The kit is the parsed one (cdaParseLevel), so a
// level without a kit, or a kit without an ammo kind, has the map part's
// defaults (the driver alone, no ammo of a missing kind).  carry null (the level select, a restart after a
// reload): the kit, full health, no armour.  Otherwise the better of the kit
// and what the player brought from the level before, field by field: the
// carried tools with the kit's missing ones added after them (the last one
// is in hand), the higher of each ammo, the carried health and armour (the
// sim raises health to CDA_PLAYER.entryHealth on entering).  Never changes
// carry.

var CDA_LEVELS = [CDA_LEVEL_DOCK, CDA_LEVEL_MEETME, CDA_LEVEL_AISLE, CDA_LEVEL_HOT, CDA_LEVEL_TAPE, CDA_LEVEL_UPS, CDA_LEVEL_CABLE,
  CDA_LEVEL_NOC, CDA_LEVEL_CHILLER];

function cdaLevelCarry(index, carry) {
  var kit = cdaParseLevel(CDA_LEVELS[index]).kit;
  if (!carry) {
    return { tools: kit.tools.slice(), ammo: { cell: kit.ammo.cell, coil: kit.ammo.coil }, health: CDA_PLAYER.health, armour: 0 };
  }
  var tools = carry.tools.slice();
  for (var k = 0; k < kit.tools.length; k++) if (tools.indexOf(kit.tools[k]) < 0) tools.push(kit.tools[k]);
  return {
    tools: tools,
    ammo: { cell: Math.max(kit.ammo.cell, carry.ammo.cell), coil: Math.max(kit.ammo.coil, carry.ammo.coil) },
    health: carry.health,
    armour: carry.armour
  };
}

CDA_API.CDA_LEVELS = CDA_LEVELS;
CDA_API.cdaLevelCarry = cdaLevelCarry;
