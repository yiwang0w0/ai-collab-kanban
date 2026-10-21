package models

import "errors"

var ErrPoolExecutionUnavailable = errors.New("pool_execution_capability_unavailable")

// PoolExecutionCandidate 是原生资料的临时准入投影，不是另一份任务或配置状态。
type PoolExecutionCandidate struct {
	WorkspaceID             string
	AgentProfileID          string
	ProfileAgentRecordID    string
	AgentRecordID           string
	AgentFamily             string
	ProfileWorkspaceID      string
	AgentWorkspaceID        string
	Enabled                 bool
	Deleted                 bool
	ProviderKind            string
	AutoFallback            bool
	FallbackModel           string
	CLIPassthrough          bool
	ExecutionAgentProfileID string
	CustomTUI               bool
	ExecutorType            ExecutorType
	ExecutorStatus          ExecutorStatus
}

func (c PoolExecutionCandidate) Validate() error {
	if c.ValidateProfile() != nil ||
		c.ExecutorType != ExecutorTypeWorktree || c.ExecutorStatus != ExecutorStatusActive {
		return ErrPoolExecutionUnavailable
	}
	return nil
}

// ValidateProfile 只核对静态 CLI 配置，不代表执行器、认证或本次启动已获准。
func (c PoolExecutionCandidate) ValidateProfile() error {
	if !c.validIdentity() || !c.validProfile() || !supportedPoolAgentFamily(c.AgentFamily) {
		return ErrPoolExecutionUnavailable
	}
	return nil
}

func (c PoolExecutionCandidate) validIdentity() bool {
	return c.WorkspaceID != "" && c.AgentProfileID != "" && c.AgentRecordID != "" && c.ProfileAgentRecordID == c.AgentRecordID &&
		(c.ProfileWorkspaceID == "" || c.ProfileWorkspaceID == c.WorkspaceID) &&
		(c.AgentWorkspaceID == "" || c.AgentWorkspaceID == c.WorkspaceID)
}

func (c PoolExecutionCandidate) validProfile() bool {
	return c.Enabled && !c.Deleted && c.ProviderKind == "" && !c.AutoFallback && c.FallbackModel == "" &&
		!c.CLIPassthrough && c.ExecutionAgentProfileID == "" && !c.CustomTUI
}

func supportedPoolAgentFamily(family string) bool {
	switch family {
	case "claude-acp", "codex-app-server", "codex-acp":
		return true
	default:
		return false
	}
}
