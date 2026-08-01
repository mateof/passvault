import { useCallback, useEffect, useState } from 'react'
import { api, type Tag } from './api/passvault'
import { useT } from './i18n'
import { useSession } from './session'
import { Banner, Button, Card, Empty, Field, Form, Loading, Modal, PageHead, TagChip } from './ui'

/**
 * Labels: your own vocabulary for your own wallet.
 *
 * Distinct from the icon and colour an event already has, and worth keeping distinct. Those say
 * what kind of thing it is, from a closed set, so a concert looks like a concert in everybody's
 * wallet. A label says what it is *to you* — "Vigo trips", "work", "Ana's birthday" — which is
 * nobody else's business and cannot come from a list somebody else wrote.
 *
 * They belong to a person, not to an event: sharing an event does not share what its owner calls
 * it, and the person you shared with sees their own labels on the same event.
 */
const COLOURS = ['violet', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink']

export function TagsPage() {
  const { t, locale } = useT()
  const { me } = useSession()
  const [tags, setTags] = useState<Tag[]>()
  const [editing, setEditing] = useState<Tag>()
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setTags((await api.tags(locale)).tags)
  }, [locale])

  useEffect(() => {
    if (me?.vaultUnlocked) void load()
  }, [load, me?.vaultUnlocked])

  if (!me?.vaultUnlocked) return <Banner kind="info">{t('tags.locked')}</Banner>
  if (!tags) return <Loading />

  return (
    <>
      <PageHead
        title={t('tags.title')}
        subtitle={t('tags.subtitle')}
        action={
          <Button icon="plus" onClick={() => setCreating(true)}>
            {t('tags.create')}
          </Button>
        }
      />

      <Card>
        {tags.length === 0 ? (
          <Empty icon="events">{t('tags.empty')}</Empty>
        ) : (
          <ul className="list">
            {tags.map((tag) => (
              <li key={tag.id} className="list-row">
                <TagChip name={tag.name || t('tags.unnamed')} colour={tag.colour} />
                <span className="row-meta">{t('tags.eventCount', { count: tag.eventCount })}</span>
                <span className="button-row">
                  <Button variant="quiet" onClick={() => setEditing(tag)}>
                    {t('tags.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={async () => {
                      await api.deleteTag(locale, tag.id)
                      await load()
                    }}
                  >
                    {t('action.delete')}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={creating}
        title={t('tags.create')}
        icon="plus"
        onClose={() => setCreating(false)}
      >
        <TagForm
          onSubmit={async (name, colour) => {
            await api.createTag(locale, name, colour)
            setCreating(false)
            await load()
          }}
        />
      </Modal>

      <Modal
        open={editing !== undefined}
        title={t('tags.edit')}
        onClose={() => setEditing(undefined)}
      >
        {editing ? (
          <TagForm
            initialName={editing.name}
            initialColour={editing.colour}
            onSubmit={async (name, colour) => {
              await api.updateTag(locale, editing.id, { name, colour })
              setEditing(undefined)
              await load()
            }}
          />
        ) : null}
      </Modal>
    </>
  )
}

export function TagForm({
  initialName = '',
  initialColour = 'violet',
  onSubmit,
}: {
  initialName?: string
  initialColour?: string
  onSubmit: (name: string, colour: string) => Promise<void>
}) {
  const { t } = useT()
  const [name, setName] = useState(initialName)
  const [colour, setColour] = useState(initialColour)

  return (
    <Form
      submitLabel={t('action.save')}
      submitIcon="check"
      disabled={name.trim() === ''}
      onSubmit={() => onSubmit(name.trim(), colour)}
    >
      <Field label={t('tags.name')} value={name} onChange={setName} required />
      {/* Swatches rather than a dropdown of colour names, for the same reason the event mark
          uses them: the value of a colour is that it is recognised at a glance, and a list of
          words is exactly what cannot be. */}
      <div className="swatches">
        {COLOURS.map((option) => (
          <button
            key={option}
            type="button"
            className={`swatch mark-${option}${colour === option ? ' swatch-on' : ''}`}
            aria-label={option}
            onClick={() => setColour(option)}
          />
        ))}
      </div>
    </Form>
  )
}
