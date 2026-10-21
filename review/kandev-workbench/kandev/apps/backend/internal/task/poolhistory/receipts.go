package poolhistory

import (
	"encoding/json"
	"errors"
	"io"
	"strings"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
)

var errReceiptUnverified = errors.New("pool_history_receipt_unverified")

type receiptGroup map[string][]*runsmodels.RunEvent

func claimReceipts(snapshot *Snapshot, selection Selection) (receiptGroup, error) {
	if snapshot.EvidenceIncomplete {
		return nil, errReceiptUnverified
	}
	group := make(receiptGroup)
	for _, event := range snapshot.Events {
		if event == nil || event.RunID != selection.RunID {
			continue
		}
		var scope struct {
			ClaimID string `json:"claim_id"`
		}
		if json.Unmarshal([]byte(event.Payload), &scope) != nil || scope.ClaimID == "" {
			return nil, errReceiptUnverified
		}
		if scope.ClaimID != selection.ClaimID {
			continue
		}
		if event.Seq < 0 || event.CreatedAt.IsZero() || !knownReceiptKind(string(event.EventType)) {
			return nil, errReceiptUnverified
		}
		group[string(event.EventType)] = append(group[string(event.EventType)], event)
	}
	return group, nil
}

func knownReceiptKind(kind string) bool {
	switch kind {
	case runsmodels.PoolLaunchAdmitted, runsmodels.PoolExecutionAllocated, runsmodels.PoolExecutionBound,
		runsmodels.PoolWorkObserved, runsmodels.PoolTurnEnded, runsmodels.PoolExecutionStopped, runsmodels.PoolExecutionFinished,
		runsmodels.PoolRecoveryStopRequested, runsmodels.PoolRecoveryRequeued:
		return true
	default:
		return false
	}
}

func uniqueReceipt[T any](rows []*runsmodels.RunEvent, accept func(T) bool) (*T, *runsmodels.RunEvent, error) {
	var chosen *T
	var recorded *runsmodels.RunEvent
	for _, row := range rows {
		var value T
		if !decodeReceipt(row.Payload, &value) || !accept(value) {
			continue
		}
		if chosen != nil {
			return nil, nil, errReceiptUnverified
		}
		chosen, recorded = &value, row
	}
	if len(rows) != 0 && chosen == nil {
		return nil, nil, errReceiptUnverified
	}
	return chosen, recorded, nil
}

func decodeReceipt(payload string, target any) bool {
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return false
	}
	return decoder.Decode(new(any)) == io.EOF
}
