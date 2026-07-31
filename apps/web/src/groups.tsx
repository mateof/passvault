import { useCallback, useEffect, useState } from 'react'
import { api, type Group, type GroupMember } from './api/passvault'
import { useT } from './i18n'
import { useSession } from './session'
import { Banner, Button, Card, Empty, Field, Form, Loading, PageHead } from './ui'

/**
 * The people you share an event with more than once.
 *
 * A group exists so that "the family" is typed once instead of four addresses per concert. That
 * is the whole feature, and it is why this screen is a list of names with the people under each
 * one rather than a general-purpose permissions editor.
 *
 * Members are added by address and checked as they are typed. An address with a typo in it used
 * to be discovered at the far end of the process — when a friend never saw the ticket — so the
 * field says whether anybody here uses that address before the button will do anything.
 */
export function GroupsPage() {
  const { t, locale } = useT()
  const { me } = useSession()
  const [groups, setGroups] = useState<Group[]>()
  const [failure, setFailure] = useState<string>()
  const [open, setOpen] = useState<string>()

  const load = useCallback(async () => {
    try {
      setGroups((await api.groups(locale)).groups)
      setFailure(undefined)
    } catch {
      setFailure(t('groups.error.load'))
    }
  }, [locale, t])

  useEffect(() => {
    if (me?.vaultUnlocked) void load()
  }, [load, me?.vaultUnlocked])

  if (!me?.vaultUnlocked) {
    // Group names are encrypted, and the screen would otherwise be a list of empty rows.
    return <Banner kind="info">{t('groups.locked')}</Banner>
  }
  if (!groups) return <Loading />

  return (
    <>
      <PageHead title={t('groups.title')} subtitle={t('groups.subtitle')} />
      {failure ? <Banner kind="error">{failure}</Banner> : null}

      <Card title={t('groups.create')} icon="users">
        <NewGroup onCreated={load} />
      </Card>

      {groups.length === 0 ? (
        <Empty icon="users">{t('groups.empty')}</Empty>
      ) : (
        groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            isOpen={open === group.id}
            onToggle={() => setOpen(open === group.id ? undefined : group.id)}
            onChanged={load}
          />
        ))
      )}
    </>
  )
}

function NewGroup({ onCreated }: { onCreated: () => Promise<void> }) {
  const { t, locale } = useT()
  const [name, setName] = useState('')

  return (
    <Form
      submitLabel={t('groups.create')}
      submitIcon="plus"
      disabled={name.trim() === ''}
      onSubmit={async () => {
        await api.createGroup(locale, name.trim())
        setName('')
        await onCreated()
      }}
    >
      <Field label={t('groups.name')} value={name} onChange={setName} required />
    </Form>
  )
}

function GroupCard({
  group,
  isOpen,
  onToggle,
  onChanged,
}: {
  group: Group
  isOpen: boolean
  onToggle: () => void
  onChanged: () => Promise<void>
}) {
  const { t, locale } = useT()
  const [members, setMembers] = useState<GroupMember[]>()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(group.name)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const loadMembers = useCallback(async () => {
    setMembers((await api.groupMembers(locale, group.id)).members)
  }, [group.id, locale])

  useEffect(() => {
    if (isOpen) void loadMembers()
  }, [isOpen, loadMembers])

  return (
    <Card>
      <div className="row-head">
        <button className="row-toggle" onClick={onToggle}>
          <strong>{group.name || t('groups.unnamed')}</strong>
          <span className="row-meta">{t('groups.memberCount', { count: group.memberCount })}</span>
        </button>
        {group.isOwner ? (
          <div className="button-row">
            <Button variant="quiet" onClick={() => setRenaming(!renaming)}>
              {t('groups.rename')}
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              {t('action.delete')}
            </Button>
          </div>
        ) : null}
      </div>

      {renaming ? (
        <Form
          submitLabel={t('action.save')}
          submitIcon="check"
          disabled={name.trim() === ''}
          onSubmit={async () => {
            await api.renameGroup(locale, group.id, name.trim())
            setRenaming(false)
            await onChanged()
          }}
        >
          <Field label={t('groups.name')} value={name} onChange={setName} required />
        </Form>
      ) : null}

      {confirmDelete ? (
        <>
          {/* Said before it happens rather than after: deleting a group closes every event it
              was opening, which is not obvious from the word "delete". */}
          <Banner kind="warning">{t('groups.deleteWarning')}</Banner>
          <div className="button-row">
            <Button
              variant="danger"
              onClick={async () => {
                await api.deleteGroup(locale, group.id)
                setConfirmDelete(false)
                await onChanged()
              }}
            >
              {t('groups.deleteConfirm')}
            </Button>
            <Button variant="quiet" onClick={() => setConfirmDelete(false)}>
              {t('action.cancel')}
            </Button>
          </div>
        </>
      ) : null}

      {isOpen ? (
        <>
          {members === undefined ? (
            <Loading />
          ) : (
            <ul className="list">
              {members.map((member) => (
                <li key={member.userId} className="list-row">
                  <span>
                    {member.email}
                    {member.role === 'OWNER' ? ` · ${t('groups.owner')}` : ''}
                  </span>
                  {group.isOwner && member.role !== 'OWNER' ? (
                    <Button
                      variant="quiet"
                      onClick={async () => {
                        await api.removeGroupMember(locale, group.id, member.userId)
                        await loadMembers()
                        await onChanged()
                      }}
                    >
                      {t('groups.remove')}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {group.isOwner ? (
            <AddMember
              groupId={group.id}
              onAdded={async () => {
                await loadMembers()
                await onChanged()
              }}
            />
          ) : null}
        </>
      ) : null}
    </Card>
  )
}

/**
 * Adding somebody, with the address checked while it is typed.
 *
 * The check is a courtesy and not the control: the server refuses an unknown address on its own,
 * because a browser saying "this is fine" is not a reason to trust anything. What it buys is that
 * a typo is visible next to the field instead of arriving as a failed submission.
 */
function AddMember({ groupId, onAdded }: { groupId: string; onAdded: () => Promise<void> }) {
  const { t, locale } = useT()
  const [email, setEmail] = useState('')
  const known = useKnownAddress(email)

  return (
    <Form
      submitLabel={t('groups.add')}
      submitIcon="plus"
      disabled={known !== true}
      onSubmit={async () => {
        await api.addGroupMember(locale, groupId, email.trim())
        setEmail('')
        await onAdded()
      }}
    >
      <Field
        label={t('groups.email')}
        value={email}
        onChange={setEmail}
        type="email"
        autoComplete="off"
        {...(known === false ? { help: t('groups.unknownEmail') } : {})}
        {...(known === true ? { help: t('groups.knownEmail') } : {})}
      />
    </Form>
  )
}

/**
 * Whether an address belongs to an account here: true, false, or not asked yet.
 *
 * Debounced, because this fires on a keystroke and the question is an existence check against
 * every account on the server. Half a second is long enough that typing an address asks once
 * rather than thirty times, and short enough that the answer feels like part of the field.
 */
function useKnownAddress(email: string): boolean | undefined {
  const { locale } = useT()
  const [known, setKnown] = useState<boolean>()

  useEffect(() => {
    const trimmed = email.trim()
    if (!trimmed.includes('@') || trimmed.length < 5) {
      setKnown(undefined)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      api
        .lookup(locale, trimmed)
        .then((result) => {
          if (!cancelled) setKnown(result.exists)
        })
        .catch(() => {
          if (!cancelled) setKnown(undefined)
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [email, locale])

  return known
}

export { useKnownAddress }
