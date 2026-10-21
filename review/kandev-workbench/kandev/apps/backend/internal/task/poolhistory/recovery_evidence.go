package poolhistory

import (
	"encoding/json"
	"strings"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

// projectWithdrawal 只呈现同一原生取消提交的回执，不把 cancelled 行推断为停止。
func projectWithdrawal(snapshot *Snapshot, entry Entry, run *runsmodels.Run, item Item) Item {
	item.Reason = "withdrawal_unverified"
	if snapshot.EvidenceIncomplete || run.ClaimedAt != nil || run.SessionID != "" || run.Outcome != nil ||
		run.FinishedAt == nil || run.CancelReason == nil || *run.CancelReason != "pool_withdrawn" {
		return item
	}
	for _, count := range snapshot.ClaimCounts {
		if count.RunID == run.ID && count.Total != 0 {
			return item
		}
	}
	var receipt *runsmodels.RunEvent
	for _, event := range snapshot.Events {
		if event == nil || event.RunID != run.ID {
			continue
		}
		if receipt != nil || event.EventType != runsmodels.PoolRecoveryWithdrawn {
			return item
		}
		receipt = event
	}
	if !validWithdrawalReceipt(receipt, snapshot, entry, run) {
		return item
	}
	item.State, item.Reason, item.EndedAt = "withdrawn", "", &receipt.CreatedAt
	item.Current = entry.ID == snapshot.LatestEntryID && entry.WorkflowID == snapshot.CurrentWorkflowID && entry.StepID == snapshot.CurrentStepID
	return item
}

func validWithdrawalReceipt(event *runsmodels.RunEvent, snapshot *Snapshot, entry Entry, run *runsmodels.Run) bool {
	if event == nil || event.Seq < 0 || event.CreatedAt.IsZero() || !event.CreatedAt.Equal(*run.FinishedAt) || event.CreatedAt.Before(run.RequestedAt) {
		return false
	}
	var operation runsmodels.PoolRecoveryOperation
	if json.Unmarshal([]byte(event.Payload), &operation) != nil {
		return false
	}
	return operation.Command.Valid() && operation.Command.Action == "withdraw" && operation.Command.RunID == run.ID &&
		operation.TaskID == snapshot.TaskID && operation.WorkspaceID == snapshot.WorkspaceID && operation.EntryID == entry.ID &&
		operation.Result == "withdrawn" && operation.ActorID != "" && len(operation.ActorID) <= 256 && strings.TrimSpace(operation.ActorID) == operation.ActorID
}
