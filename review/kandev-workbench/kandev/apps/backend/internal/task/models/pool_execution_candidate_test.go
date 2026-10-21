package models

import "testing"

func TestPoolExecutionCandidateUsesNativeIdentityAndFixedRuntime(t *testing.T) {
	base := PoolExecutionCandidate{WorkspaceID: "workspace", AgentProfileID: "profile-record",
		ProfileAgentRecordID: "agent-record", AgentRecordID: "agent-record", AgentFamily: "claude-acp", Enabled: true,
		ExecutorType: ExecutorTypeWorktree, ExecutorStatus: ExecutorStatusActive}
	for _, family := range []string{"claude-acp", "codex-acp", "codex-app-server"} {
		choice := base
		choice.AgentFamily = family
		if err := choice.Validate(); err != nil {
			t.Fatalf("受支持的固定 CLI 资料应有效: %s %v", family, err)
		}
	}
	cases := []struct {
		name string
		edit func(*PoolExecutionCandidate)
	}{
		{"not_record_id", func(c *PoolExecutionCandidate) { c.ProfileAgentRecordID = "claude-acp" }},
		{"foreign_agent", func(c *PoolExecutionCandidate) { c.AgentWorkspaceID = "other-workspace" }},
		{"custom_tui", func(c *PoolExecutionCandidate) { c.CustomTUI = true }},
		{"unknown_executor", func(c *PoolExecutionCandidate) { c.ExecutorStatus = "unknown" }},
		{"display_name", func(c *PoolExecutionCandidate) { c.AgentFamily = "Claude" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			choice := base
			tc.edit(&choice)
			if err := choice.Validate(); err != ErrPoolExecutionUnavailable {
				t.Fatalf("缺少可信身份或能力应拒绝: %v", err)
			}
		})
	}
}
