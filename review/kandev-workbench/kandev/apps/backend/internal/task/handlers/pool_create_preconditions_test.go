package handlers

import (
	"net/http"
	"testing"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-005.4
func TestPoolCreateWireRejectsUnconfirmedOrUnavailableCreation(t *testing.T) {
	cases := []struct {
		name string
		edit func(*poolMoveWireFixture, map[string]any)
	}{
		{"missing", func(_ *poolMoveWireFixture, payload map[string]any) { delete(payload, "pool_release") }},
		{"quota", func(_ *poolMoveWireFixture, payload map[string]any) {
			payload["pool_release"].(map[string]any)["confirm_cli_quota"] = false
		}},
		{"task_version", func(_ *poolMoveWireFixture, payload map[string]any) {
			payload["pool_release"].(map[string]any)["expected_resource_version"] = "2020-01-01T00:00:00Z"
		}},
		{"step_version", func(_ *poolMoveWireFixture, payload map[string]any) {
			payload["pool_release"].(map[string]any)["expected_step_version"] = "2020-01-01T00:00:00Z"
		}},
		{"self_reported_actor", func(_ *poolMoveWireFixture, payload map[string]any) {
			payload["pool_release"].(map[string]any)["actor_id"] = "untrusted-create-actor"
		}},
		{"publisher_off", func(f *poolMoveWireFixture, _ map[string]any) { f.service.SetPoolRunQueue(nil) }},
		{"admission_off", func(f *poolMoveWireFixture, _ map[string]any) { f.service.SetPoolReleaseAdmission(nil) }},
		{"direct_start", func(_ *poolMoveWireFixture, payload map[string]any) {
			payload["start_agent"], payload["agent_profile_id"] = true, "pool-wire-profile"
		}},
		{"token", func(f *poolMoveWireFixture, _ map[string]any) {
			f.ctx = authn.WithIdentity(f.ctx, authn.Identity{UserID: "pool-wire-human", Role: authn.RoleAdmin, TokenID: "token", SessionID: "browser"})
		}},
		{"synthetic", func(f *poolMoveWireFixture, _ map[string]any) {
			f.ctx = authn.WithIdentity(f.ctx, authn.Identity{UserID: "pool-wire-human", Role: authn.RoleAdmin, Synthetic: true, SessionID: "browser"})
		}},
		{"foreign", func(f *poolMoveWireFixture, _ map[string]any) {
			f.ctx = authn.WithIdentity(f.ctx, authn.Identity{UserID: "pool-wire-outsider", Role: authn.RoleMember, SessionID: "browser"})
		}},
	}
	for _, transport := range []string{"http", "websocket"} {
		for _, test := range cases {
			t.Run(transport+"/"+test.name, func(t *testing.T) {
				f, dispatcher := newPoolCreateFixture(t)
				payload := f.createPayload()
				test.edit(&f, payload)
				status, body := f.create(t, transport, payload)
				require.NotEqual(t, http.StatusOK, status, string(body))
				require.NotContains(t, string(body), "untrusted-create-actor")
				assertPoolCreateUnpublished(t, f, dispatcher)
				var count int
				require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM tasks`))
				require.Equal(t, 1, count, "拒绝创建时不应残留新卡")
			})
		}
	}
}
