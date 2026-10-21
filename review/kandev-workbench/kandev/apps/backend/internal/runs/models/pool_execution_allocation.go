package models

import "strings"

// ValidAllocationFor 限定首次新执行的宿主身份，不补造尚未产生的提供商 operation。
func (i PoolExecutionIdentity) ValidAllocationFor(request PoolClaimStart) bool {
	if !request.Valid() || !i.matchesPoolRequest(request) || i.OperationID != "" || i.OperationSource != "" || i.PromptGeneration != 1 {
		return false
	}
	for _, id := range []string{i.SessionID, i.ExecutionID, i.TurnID} {
		if id == "" || len(id) > 256 || strings.TrimSpace(id) != id {
			return false
		}
	}
	return true
}

func (i PoolExecutionIdentity) matchesPoolRequest(request PoolClaimStart) bool {
	return i.RunID == request.RunID && i.ClaimID == request.ClaimID && i.TaskID == request.Release.TaskID &&
		i.AgentProfileID == request.Release.AgentProfileID && i.ExecutionProfileID == i.AgentProfileID
}

// ReceiptIdentity 只把匹配的首轮可信活动关联到已持久化分配，明确 operation 的来源。
func (a PoolExecutionActivity) ReceiptIdentity(allocation PoolExecutionAllocation) (PoolExecutionIdentity, bool) {
	if !a.validSource() {
		return PoolExecutionIdentity{}, false
	}
	return a.receiptIdentity(allocation)
}

// TurnEndIdentity 不借用开工来源；完成通知必须独立匹配同一宿主分配。
func (a PoolExecutionActivity) TurnEndIdentity(allocation PoolExecutionAllocation) (PoolExecutionIdentity, bool) {
	if a.StartedSource != "" {
		return PoolExecutionIdentity{}, false
	}
	return a.receiptIdentity(allocation)
}

func (a PoolExecutionActivity) receiptIdentity(allocation PoolExecutionAllocation) (PoolExecutionIdentity, bool) {
	i := allocation.PoolExecutionIdentity
	if !a.matchesAllocation(allocation) {
		return PoolExecutionIdentity{}, false
	}
	switch a.AgentType {
	case "codex-app-server":
		if a.OperationID == "" || len(a.OperationID) > 256 || strings.TrimSpace(a.OperationID) != a.OperationID {
			return PoolExecutionIdentity{}, false
		}
		i.OperationID, i.OperationSource = a.OperationID, PoolOperationProvider
	case "claude-acp", "codex-acp":
		if a.OperationID != "" {
			return PoolExecutionIdentity{}, false
		}
		i.OperationID, i.OperationSource = i.TurnID, PoolOperationHostTurn
	default:
		return PoolExecutionIdentity{}, false
	}
	return i, true
}

func (a PoolExecutionActivity) matchesAllocation(allocation PoolExecutionAllocation) bool {
	i := allocation.PoolExecutionIdentity
	return a.TaskID == i.TaskID && a.AgentProfileID == i.AgentProfileID && a.SessionID == i.SessionID &&
		a.ExecutionID == i.ExecutionID && a.TurnID == i.TurnID && a.PromptGeneration == i.PromptGeneration && a.AgentType == allocation.AgentType
}

func (a PoolExecutionActivity) validSource() bool {
	switch a.StartedSource {
	case PoolStartCodexProvider:
		return a.AgentType == "codex-app-server"
	case PoolStartAssistant, PoolStartTool:
		return true
	default:
		return false
	}
}
