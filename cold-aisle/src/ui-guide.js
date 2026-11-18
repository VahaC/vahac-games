// ── ui-guide: the How to play guide under the game: its numbers, its sprites, its upgrade list ──
// Owns cdaBuildGuide.  Uses tables (CDA_UPGRADES), textures (through
// cdaPaint), ui-text (cdaGuideNumber, cdaUpgradeEffect) and ui-page.
//
// The guide is markup in index.html (a <details>, open by default, shown on
// a narrow window too).  At start-up every element with data-cda-num gets
// cdaGuideNumber of its key, every canvas with data-cda-sprite the game's
// own sprite of that name, and the upgrade list is written from
// CDA_UPGRADES: a retune of the tables never leaves a wrong number there.

function cdaBuildGuide() {
  var nums = document.querySelectorAll('[data-cda-num]');
  for (var i = 0; i < nums.length; i++) cdaSetText(nums[i], cdaGuideNumber(nums[i].getAttribute('data-cda-num')));
  var sprites = document.querySelectorAll('[data-cda-sprite]');
  for (i = 0; i < sprites.length; i++) cdaPaint(sprites[i], sprites[i].getAttribute('data-cda-sprite'));
  var list = CDA_RT.els.guideUpgrades;
  list.textContent = '';
  for (i = 0; i < CDA_UPGRADES.length; i++) {
    var line = CDA_UPGRADES[i];
    var li = cdaMake('li', 'cda-guide-upgrade', '');
    li.appendChild(cdaMake('strong', 'cda-guide-name', line.name + ':'));
    li.appendChild(document.createTextNode(' ' + cdaUpgradeEffect(line.id, 1) + ' a tier, ' + line.costs.length + ' tiers for ' +
      line.costs.join(' / ') + ' patches.'));
    list.appendChild(li);
  }
}

CDA_API.cdaBuildGuide = cdaBuildGuide;
