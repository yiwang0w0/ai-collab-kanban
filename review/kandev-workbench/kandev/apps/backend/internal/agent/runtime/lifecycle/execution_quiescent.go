package lifecycle

import (
	"context"
	"errors"
	"strings"
)

var ErrExecutionResourcesUnconfirmed = errors.New("execution_resources_unconfirmed")

// CheckExecutionQuiescent 只读核验当前登记和所有权，必须与已提交的本次停止证明配合；缺登记本身不是停止证明。
func (m *Manager) CheckExecutionQuiescent(ctx context.Context, executionID, taskID, sessionID string) error {
	if m == nil || m.executionStore == nil {
		return ErrExecutionResourcesUnconfirmed
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	for _, id := range []string{executionID, taskID, sessionID} {
		if id == "" || len(id) > 256 || strings.TrimSpace(id) != id {
			return ErrExecutionResourcesUnconfirmed
		}
	}
	if m.executionStore.hasExecutionOccupancy(executionID, taskID, sessionID) || !m.executionActivityReleased(executionID) {
		return ErrExecutionResourcesUnconfirmed
	}
	return nil
}

// 缺少 session 索引的原生任务执行也算占用，不能借用面向正常引用的过滤列表证明清空。
func (s *ExecutionStore) hasExecutionOccupancy(executionID, taskID, sessionID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for storedID, execution := range s.executions {
		if storedID == executionID || execution == nil || execution.TaskID == taskID || execution.SessionID == sessionID {
			return true
		}
	}
	_, indexed := s.bySession[sessionID]
	return indexed
}
