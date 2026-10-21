package lifecycle

import (
	"context"
	"errors"
	"strings"

	agentctl "github.com/kandev/kandev/internal/agent/runtime/agentctl"
)

var ErrExecutionStopUnconfirmed = errors.New("execution_stop_unconfirmed")

// StopInstanceConfirmed 不把空实例或一次成功返回当作停止证明；只确认同范围实例的删除后置条件。
func (r *StandaloneExecutor) StopInstanceConfirmed(ctx context.Context, instance *ExecutorInstance, force bool) (bool, error) {
	if r == nil || r.ctl == nil || instance == nil {
		return false, ErrExecutionStopUnconfirmed
	}
	for _, id := range []string{instance.InstanceID, instance.TaskID, instance.SessionID, instance.StandaloneInstanceID} {
		if id == "" || len(id) > 256 || strings.TrimSpace(id) != id {
			return false, ErrExecutionStopUnconfirmed
		}
	}
	before, err := r.ctl.GetInstance(ctx, instance.StandaloneInstanceID)
	if err != nil || before == nil || before.ID != instance.StandaloneInstanceID || before.TaskID != instance.TaskID || before.SessionID != instance.SessionID {
		return false, errors.Join(ErrExecutionStopUnconfirmed, err)
	}
	if err := r.StopInstance(ctx, instance, force); err != nil {
		return false, errors.Join(ErrExecutionStopUnconfirmed, err)
	}
	_, err = r.ctl.GetInstance(ctx, instance.StandaloneInstanceID)
	if !errors.Is(err, agentctl.ErrInstanceNotFound) {
		return false, errors.Join(ErrExecutionStopUnconfirmed, err)
	}
	return true, nil
}
