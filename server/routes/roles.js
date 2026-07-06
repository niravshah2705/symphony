'use strict';

const express = require('express');
const { getApiKey, getAssumedRole, setAssumedRole } = require('../store');
const { getUsers } = require('../linear');
const { asyncHandler } = require('../util');

const router = express.Router();

function toMember(user) {
  return { id: user.id, name: user.displayName || user.name, email: user.email };
}

// GET /api/roles/members — assumable members (active org users).
router.get(
  '/members',
  asyncHandler(async (req, res) => {
    const users = await getUsers(getApiKey());
    res.json({ members: users.map(toMember) });
  })
);

// GET /api/roles/assumed — the currently assumed role.
router.get('/assumed', (req, res) => {
  res.json({ assumedRole: getAssumedRole() });
});

// PUT /api/roles/assumed — assume a member. The id is validated server-side
// against the real member list (never trust a client-supplied identity).
router.put(
  '/assumed',
  asyncHandler(async (req, res) => {
    const id = req.body && req.body.id ? String(req.body.id) : '';
    if (!id) return res.status(400).json({ error: 'A member id is required.' });

    const users = await getUsers(getApiKey());
    const match = users.find((u) => u.id === id);
    if (!match) return res.status(404).json({ error: 'Member not found in this workspace.' });

    const assumedRole = toMember(match);
    setAssumedRole(assumedRole);
    res.json({ assumedRole });
  })
);

// DELETE /api/roles/assumed — drop the assumed role.
router.delete('/assumed', (req, res) => {
  setAssumedRole(null);
  res.json({ assumedRole: null });
});

module.exports = router;
