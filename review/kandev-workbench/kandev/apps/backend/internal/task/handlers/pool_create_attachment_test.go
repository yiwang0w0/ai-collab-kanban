package handlers

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/service"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.1 AC-TASKS-AGENT-POOL-001.3
func TestPoolCreateWireClaimsAttachmentsBeforePublishing(t *testing.T) {
	for _, transport := range []string{"http", "websocket"} {
		t.Run(transport, func(t *testing.T) {
			f, dispatcher := newPoolCreateFixture(t)
			attachments, err := service.NewAttachmentService(f.tasks, t.TempDir(), nil, f.handler.logger)
			require.NoError(t, err)
			f.service.SetAttachmentService(attachments)
			attachment, err := attachments.Stage(f.ctx, "pool-wire-human", f.task.WorkspaceID, "required.txt", "text/plain", "resource", "path", strings.NewReader("required-create-input"))
			require.NoError(t, err)
			dispatcher.onDispatch = func(ctx context.Context, taskID string) {
				current, err := f.tasks.GetMessageAttachment(ctx, attachment.ID)
				require.NoError(t, err)
				require.Equal(t, taskID, current.TaskID, "文件绑定完成前不能派发")
				require.Equal(t, models.AttachmentStateClaimed, current.State)
			}
			payload := f.createPayload()
			payload["attachments"] = []map[string]any{{"attachment_id": attachment.ID, "type": attachment.Kind,
				"name": attachment.Name, "mime_type": attachment.MimeType, "size_bytes": attachment.SizeBytes, "delivery_mode": attachment.DeliveryMode}}
			status, body := f.create(t, transport, payload)
			require.Equal(t, http.StatusOK, status, string(body))
			require.Equal(t, 1, dispatcher.calls)
		})
	}
}
