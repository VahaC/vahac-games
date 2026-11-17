// tests/packet-siege.campaign-foes-4.test.js
// Packet Siege, levels 51-150: contract 5 for the twelve new enemies, shard 4
// of 4 (see packet-siege.campaign-foes-1.test.js): on the level that
// introduces each of this shard's enemies the bot wins clearly more over the
// band without it.  Which enemies are this shard's is in SHARDS of
// _packet-siege-band.js.
'use strict';

const { enemyTests } = require('./_packet-siege-band');

enemyTests(__filename);
