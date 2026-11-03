export const invitationPermissionsMigration=`
CREATE TABLE user_invite_groups (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,group_id)
);
`;
