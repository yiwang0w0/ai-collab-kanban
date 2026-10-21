package service

import (
	"encoding/json"

	"github.com/kandev/kandev/internal/runs/models"
)

// SetPoolProjectionObserver 仅在构造期注入宿主的提交后通知，不等待查询或改变执行结果。
func (s *Service) SetPoolProjectionObserver(observer func(models.PoolProjectionCommit)) {
	s.poolProjectionObserver = observer
}

func (s *Service) notifyPoolProjection(taskID string, event *models.RunEvent) {
	if s.poolProjectionObserver == nil || event == nil {
		return
	}
	var scope struct {
		ClaimID string `json:"claim_id"`
	}
	if json.Unmarshal([]byte(event.Payload), &scope) != nil || scope.ClaimID == "" {
		return
	}
	s.poolProjectionObserver(models.PoolProjectionCommit{TaskID: taskID, RunID: event.RunID,
		ClaimID: scope.ClaimID, Sequence: event.Seq, Kind: string(event.EventType)})
}
