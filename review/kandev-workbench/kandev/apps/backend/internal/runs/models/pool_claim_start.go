package models

import (
	"encoding/json"
	"strings"
)

// Valid 仅检查宿主身份形状；实际领取和原生资格仍须在写事务内核验。
func (p PoolClaimStart) Valid() bool {
	ids := []string{p.RunID, p.ClaimID, p.Release.TaskID, p.Release.WorkspaceID,
		p.Release.WorkflowID, p.Release.WorkflowStepID, p.Release.AgentProfileID, p.Release.ActorID}
	for _, id := range ids {
		if id == "" || len(id) > 256 || strings.TrimSpace(id) != id {
			return false
		}
	}
	return p.Release.EntryID > 0 && !p.Release.ReleasedAt.IsZero()
}

// PoolStartRequest 提取原子领取的不可变值，不把启动授权附着到通用上下文。
func (c *ClaimedRun) PoolStartRequest() (PoolClaimStart, error) {
	if c == nil || c.Run == nil || c.Status != RunStatusClaimed || c.ClaimedAt == nil {
		return PoolClaimStart{}, ErrPoolClaimStartConflict
	}
	var envelope poolRunEnvelope
	if err := json.Unmarshal([]byte(c.Payload), &envelope); err != nil {
		return PoolClaimStart{}, ErrPoolClaimStartConflict
	}
	request := PoolClaimStart{RunID: c.ID, ClaimID: c.ClaimID, Release: envelope.PoolRelease}
	if !request.Valid() || !request.Release.MatchesRun(c.Run) {
		return PoolClaimStart{}, ErrPoolClaimStartConflict
	}
	return request, nil
}
