import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

process.env.SHATKI_DATA_FILE = "./data/profiles.test.json";
const store = await import("./profiles.js");

test("server case charges currency and persists the awarded item in the profile", () => {
  const created = store.createGuest("CaseTester");
  assert.equal(created.profile.currency, 500);
  const opened = store.openProfileCase(created.profile.id);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.profile.currency, 350);
  assert.equal(opened.profile.inventory.length, 1);
  assert.equal(opened.profile.inventory[0].id, opened.item.id);
  assert.ok(["common", "uncommon", "rare", "mythical", "legendary", "ancient"].includes(opened.item.rarity));
});

test("server rejects case opening when the profile cannot afford it", () => {
  const created = store.createGuest("PoorTester");
  store.updateProfile(created.profile.id, { currency: 0 });
  const result = store.openProfileCase(created.profile.id);
  assert.deepEqual(result, { ok: false, error: "INSUFFICIENT_FUNDS" });
});

test("equipping a skin is restricted to owned items and persists by weapon", () => {
  const created = store.createGuest("EquipTester");
  const opened = store.openProfileCase(created.profile.id);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const equipped = store.equipProfileSkin(created.profile.id, opened.item.id);
  assert.equal(equipped.ok, true);
  if (!equipped.ok) return;
  assert.equal(equipped.profile.equipped[opened.item.weaponId], opened.item.id);
  assert.deepEqual(store.equipProfileSkin(created.profile.id, "not-owned"), { ok: false, error: "SKIN_NOT_OWNED" });
});

test("unknown profile cannot open a case", () => {
  assert.deepEqual(store.openProfileCase("not-a-profile"), { ok: false, error: "PROFILE_NOT_FOUND" });
});

test("guest profile can be upgraded to a password account without losing inventory or currency", () => {
  const created = store.createGuest("AccountTester");
  const opened = store.openProfileCase(created.profile.id);
  assert.equal(opened.ok, true);
  const upgraded = store.upgradeGuestAccount(created.token, "account_tester", "correct horse battery");
  assert.equal(upgraded.ok, true);
  if (!upgraded.ok) return;
  assert.equal(upgraded.profile.hasAccount, true);
  assert.equal(upgraded.profile.inventory.length, 1);
  assert.equal(upgraded.profile.currency, 350);
  assert.equal(store.upgradeGuestAccount(created.token, "another_user", "correct horse battery").ok, false);
});

test("password account login issues a fresh token and rejects invalid credentials", () => {
  const created = store.createGuest("LoginTester");
  const upgraded = store.upgradeGuestAccount(created.token, "login_tester", "this is a secure password");
  assert.equal(upgraded.ok, true);
  const wrong = store.loginAccount("login_tester", "wrong password");
  assert.deepEqual(wrong, { ok: false, error: "INVALID_CREDENTIALS" });
  const login = store.loginAccount("login_tester", "this is a secure password");
  assert.equal(login.ok, true);
  if (!login.ok) return;
  assert.equal(login.profile.hasAccount, true);
  assert.equal(store.getProfileByToken(login.token)?.id, created.profile.id);
  assert.equal(store.getProfileByToken(created.token), null, "login rotates the bearer token");
});

test("account validation rejects weak passwords and malformed usernames", () => {
  const created = store.createGuest("ValidationTester");
  assert.deepEqual(store.upgradeGuestAccount(created.token, "ab", "short"), { ok: false, error: "INVALID_USERNAME" });
  assert.deepEqual(store.upgradeGuestAccount(created.token, "valid_user", "short"), { ok: false, error: "INVALID_PASSWORD" });
});

test.after(() => { try { rmSync("./data/profiles.test.json"); } catch { /* no test data was written */ } });
