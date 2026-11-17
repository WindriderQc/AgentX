"""Segment-bound actor proposals; frozen objectives and responses stay unchanged."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_grounding as grounding
import source_quote_context as quotes
import objective_actor_context as actors
import objective_review as worker
from evidence_store import load, save
from review_receipts import hashed
import test_objective_work_actors as fixtures
import test_objective_dispositions as responses
import test_objective_source_language as workers

CONTRACT = 'secretary.segment-actor-reading/v1'
OWNER = 'Personne Exemple <owner@example.invalid>'
OTHER = 'Autre Personne <other@example.invalid>'


def context(body, *, offset=0, end=None, actor_contract=CONTRACT, direction='sent', sender=OWNER, kind='body', owner_aliases=None):
    end = len(body) if end is None else end
    own = quotes.message('message01', body, {'from': sender, 'date': 'Mon, 4 May 2020 12:00:00 -0400'})
    record = {'mailDate': '2020-05-04', 'nativeRef': {
        'offset': offset, 'end': end, 'totalChars': len(body), 'direction': direction,
        'sourceContext': quotes.context(own, offset, end - offset, [own], kind=kind)}}
    manifest = {'responseSchemaSha256': hashed(grounding.SCHEMA),
                'attributionContract': quotes.OBJECTIVE_CONTRACT,
                'config': {'ownerAliases': ['Personne Exemple'] if owner_aliases is None else owner_aliases}}
    if actor_contract:
        manifest['actorReadingContract'] = actor_contract
    return grounding.extraction_context(record, manifest)


class SegmentActorContextTests(unittest.TestCase):
    def test_authored_reply_does_not_lose_its_actor_when_a_later_quote_has_another_author(self):
        body = 'Je débute la boxe.\nFrom: ' + OTHER + '\nMon voyage est terminé.'
        spans = grounding.catalog(body)
        rows = grounding.work_actors.actors(spans, context(body))
        self.assertIn('owner', rows[0]['allowedSubjects'])
        self.assertNotIn('owner', rows[2]['allowedSubjects'])
        self.assertFalse(any(row['identityVerified'] for row in rows))

    def test_legacy_mixed_page_keeps_the_original_unknown_actor(self):
        body = 'Je débute la boxe.\nFrom: ' + OTHER + '\nMon voyage est terminé.'
        rows = grounding.work_actors.actors(grounding.catalog(body), context(body, actor_contract=None))
        self.assertEqual(rows[0]['allowedSubjects'], ['unknown'])

    def rows(self, body, **kwargs):
        offset = kwargs.get('offset', 0)
        end = kwargs.get('end', len(body))
        return grounding.work_actors.actors(grounding.catalog(body[offset:end]), context(body, **kwargs))

    def test_continuation_keeps_the_full_authored_segment_without_guessing_from_a_nearby_header(self):
        body = 'Préambule assez long.\nJe débute la boxe.\nFrom: ' + OTHER + '\nMon voyage est terminé.'
        offset = body.index('Je débute')
        rows = self.rows(body, offset=offset)
        self.assertIn('owner', rows[0]['allowedSubjects'])
        self.assertNotIn('owner', rows[-1]['allowedSubjects'])
        self.assertLess(rows[0]['sourceSegment']['segmentStart'], offset)

    def test_unknown_sender_recipient_and_draft_do_not_become_the_owner(self):
        for kwargs in ({'sender': ''}, {'direction': 'received'}, {'direction': 'draft'},
                       {'direction': 'unknown'}, {'sender': OTHER}):
            with self.subTest(kwargs=kwargs):
                self.assertNotIn('owner', self.rows('Je débute la boxe.', **kwargs)[0]['allowedSubjects'])

    def test_an_owner_alias_substring_in_another_authors_name_is_not_owner_evidence(self):
        for author in ('Autre Personne pour Personne Exemple <other@example.invalid>',
                       'Personne Exemple Jr <junior@example.invalid>'):
            for body, sender in (('Je débute la boxe.', author),
                                 ('From: ' + author + '\nJe débute la boxe.', OTHER)):
                with self.subTest(author=author, body=body):
                    self.assertNotIn('owner', self.rows(body, sender=sender)[-1]['allowedSubjects'])

    def test_email_aliases_match_the_whole_address_not_a_prefix_or_display_comment(self):
        for author in ('Autre <owner@example.invalid.extra>', 'Autre <other+owner@example.invalid>',
                       'Pour owner@example.invalid <other@example.invalid>'):
            with self.subTest(author=author):
                self.assertNotIn('owner', self.rows('Je débute la boxe.', sender=author,
                    owner_aliases=['owner@example.invalid'])[0]['allowedSubjects'])

    def test_multiple_or_malformed_authors_cannot_select_a_single_identity(self):
        for author in (OWNER + ', ' + OTHER, 'Personne Exemple <owner@>',
                       'Personne Exemple"', '"Personne Exemple',
                       'Personne Exemple <owner@example..invalid>',
                       'Personne Exemple <owner@example.invalid> junk'):
            for body, sender in (('Je débute la boxe.', author),
                                 ('From: ' + author + '\nJe débute la boxe.', OTHER)):
                with self.subTest(author=author, body=body):
                    self.assertEqual(self.rows(body, sender=sender)[-1]['allowedSubjects'], ['unknown'])

    def test_complete_name_and_mailbox_aliases_still_support_owner_proposals(self):
        for author, aliases in ((OWNER, ['Personne Exemple']), ('PERSONNE EXEMPLE', ['Personne Exemple']),
                                ('Personne Exemple <OWNER@example.invalid>', ['owner@example.invalid']),
                                ('owner@example.invalid', ['owner@example.invalid']),
                                ('"Exemple, Personne" <owner@example.invalid>', ['Exemple, Personne']),
                                ('"Exemple, Personne"', ['Exemple, Personne']),
                                ('Élodie Exemple <owner@example.invalid>', ['E\u0301lodie   Exemple'])):
            with self.subTest(author=author):
                self.assertIn('owner', self.rows('Je débute la boxe.', sender=author,
                    owner_aliases=aliases)[0]['allowedSubjects'])

    def test_attachment_never_inherits_a_sender_or_literal_header_actor(self):
        body = 'From: ' + OWNER + '\nJe débute la boxe.'
        self.assertTrue(all(r['allowedSubjects'] == ['unknown'] for r in self.rows(body, kind='attachment')))

    def test_unknown_quoted_header_cannot_inherit_a_sent_container(self):
        body = 'Je débute la boxe.\n--- Original Message ---\nMon voyage est terminé.'
        rows = self.rows(body)
        self.assertIn('owner', rows[0]['allowedSubjects'])
        self.assertEqual(rows[-1]['allowedSubjects'], ['unknown'])

    def test_a_quoted_owner_uses_its_claimed_author_even_on_a_continuation(self):
        body = 'From: ' + OWNER + '\nJe débute la boxe.'
        rows = self.rows(body, offset=body.index('Je débute'), direction='received', sender=OTHER)
        self.assertIn('owner', rows[0]['allowedSubjects'])
        self.assertEqual(rows[0]['sourceSegment']['claimedAuthor'], OWNER)
        self.assertFalse(rows[0]['identityVerified'])

    def test_nested_quote_and_return_to_outer_level_stay_distinct(self):
        body = 'Je débute la boxe.\n> From: ' + OTHER + '\n> Mon voyage est terminé.\nSuite après citation.'
        rows = self.rows(body)
        self.assertIn('owner', rows[0]['allowedSubjects'])
        self.assertNotIn('owner', rows[2]['allowedSubjects'])
        self.assertEqual(rows[-1]['allowedSubjects'], ['unknown'])

    def test_an_excerpt_crossing_a_segment_boundary_is_unknown(self):
        ctx = context('Je débute la boxe.')
        ctx['actorSourceSegments'] = [
            {'start': 0, 'end': 4, 'relation': 'authored', 'author': OWNER},
            {'start': 4, 'end': 30, 'relation': 'quoted', 'claimedAuthor': OTHER}]
        row = grounding.work_actors.actors(grounding.catalog('Je débute la boxe.'), ctx)[0]
        self.assertEqual(row['allowedSubjects'], ['unknown'])

    def test_missing_or_overlapping_segments_do_not_fall_back_to_sent_direction(self):
        for segments in (None, {}, [], [None], [{'start': 0, 'end': 30, 'relation': 'authored', 'author': OWNER}] * 2):
            ctx = context('Je débute la boxe.');ctx['actorSourceSegments'] = segments
            row = grounding.work_actors.actors(grounding.catalog('Je débute la boxe.'), ctx)[0]
            with self.subTest(segments=segments):
                self.assertEqual(row['allowedSubjects'], ['unknown'])

    def test_segment_actor_support_does_not_restore_the_container_date_on_a_mixed_page(self):
        body = 'Je débute la boxe.\nFrom: ' + OTHER + '\nMon voyage est terminé.'
        ctx = context(body)
        self.assertIsNone(ctx['mailDate'])
        self.assertEqual(ctx['direction'], 'unknown')
        self.assertIn('owner', grounding.work_actors.actors(grounding.catalog(body), ctx)[0]['allowedSubjects'])

    def test_contract_requires_native_attribution_and_rejects_unknown_versions(self):
        for manifest in ({'actorReadingContract': CONTRACT}, {'actorReadingContract': 'unknown'}):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                actors.contract_for(manifest)


class SegmentActorWorkerTests(unittest.TestCase):
    setUp = workers.SourceLanguageWorkerTests.setUp
    mail = workers.SourceLanguageWorkerTests.mail
    prepare = workers.SourceLanguageWorkerTests.prepare
    run_worker = workers.SourceLanguageWorkerTests.run_worker

    def reply(self, prompt, reply):
        self.assertIn('owner', prompt['actorReadingCatalog'][0]['allowedSubjects'])
        self.assertNotIn('owner', prompt['actorReadingCatalog'][2]['allowedSubjects'])
        value = fixtures.raw(cues={
            'q1': [fixtures.moment('q1', name='Personne fictive', category='travel')],
            'q3': [fixtures.moment('q3', subject='thirdparty', name='Autre Personne', category='home')]})
        reply['response'] = json.dumps(value)
        return reply

    def source(self):
        self.mail('message01', 'Je débute la boxe.\nFrom: ' + OTHER + '\nMon déménagement est terminé.')

    def test_worker_resumes_saved_response_and_verifies_segment_proof_without_another_call(self):
        self.source()
        client, calls = responses.DispositionTests.client(self, self.reply)
        with patch.object(worker, 'normalize_representation', side_effect=ValueError('interrupted projection')):
            self.assertEqual(self.run_worker(client)['phase'], 'validation-error')
        objective, manifest = self.prepare()
        self.assertEqual(manifest['actorReadingContract'], CONTRACT)
        native = next((objective / 'review-attempts').glob('*/result.json'))
        before = native.read_bytes()
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'], 1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(native.read_bytes(), before)
        receipt = next((objective / 'page-reviews').glob('*.json'))
        row = worker.read_receipt(receipt, manifest)
        self.assertEqual([m['subject'] for m in row['result']['moments']], ['owner', 'thirdparty'])
        row['resultProcessing']['changes'][0]['workActorSelection']['actorBindings'][0]['readingContext']['sourceSegment']['author'] = OTHER
        save(receipt, row)
        with self.assertRaisesRegex(ValueError, 'retained native result'):
            worker.read_receipt(receipt, manifest)

    def test_foreign_quote_misattribution_is_retained_rejected_without_reinference(self):
        self.source()
        def invalid(prompt, reply):
            reply = self.reply(prompt, reply)
            value = json.loads(reply['response'])
            value['cueDecisions']['q3']['retainedMoments'][0].update(subject='owner', subjectName='Personne fictive')
            reply['response'] = json.dumps(value)
            return reply
        client, calls = responses.DispositionTests.client(self, invalid)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        objective, _ = self.prepare()
        self.assertEqual(load(objective / 'findings.json'), [])

    def test_existing_objective_without_actor_contract_is_not_upgraded(self):
        self.source()
        with patch.object(actors, 'CONTRACT', None):
            objective, manifest = self.prepare()
        before = (objective / 'manifest.json').read_bytes()
        self.assertNotIn('actorReadingContract', manifest)
        self.assertEqual(self.prepare()[1], manifest)
        self.assertEqual((objective / 'manifest.json').read_bytes(), before)
        self.assertNotIn('owner', grounding.work_actors.actors(grounding.catalog('Je débute la boxe.'),
            context('Je débute la boxe.\nFrom: ' + OTHER, actor_contract=None))[0]['allowedSubjects'])

    def test_quoted_alias_substring_is_rejected_by_worker_without_retry_or_output_repair(self):
        author = 'Autre Personne pour Personne fictive <other@example.invalid>'
        self.mail('message01', 'Je débute la boxe.\nFrom: ' + author + '\nMon déménagement est terminé.')
        def invalid(prompt, reply):
            reply = self.reply(prompt, reply)
            value = json.loads(reply['response'])
            value['cueDecisions']['q3']['retainedMoments'][0].update(subject='owner', subjectName='Personne fictive')
            reply['response'] = json.dumps(value)
            return reply
        client, calls = responses.DispositionTests.client(self, invalid)
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
        objective, _ = self.prepare()
        native = next((objective / 'review-attempts').glob('*/result.json'))
        original = native.read_bytes()
        self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(native.read_bytes(), original)
        self.assertEqual(load(objective / 'findings.json'), [])

    def test_malformed_retention_lists_keep_exact_response_and_rejection_across_restart(self):
        self.mail('message01', 'Mon voyage...')
        for index, bad in enumerate((None, False, {}, [None], [])):
            self.config['version'] = 'malformed-' + str(index)
            save(self.file, self.config)
            def invalid(prompt, reply):
                value = fixtures.raw();value['cueDecisions']['q1'] = {'retainedMoments': bad}
                reply['response'] = json.dumps(value)
                return reply
            client, calls = responses.DispositionTests.client(self, invalid)
            with self.subTest(bad=bad):
                self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['newlyRejectedPages'], 1)
                objective, manifest = self.prepare()
                frozen = {f: f.read_bytes() for folder in ('review-attempts', 'page-dispositions')
                          for f in (objective / folder).rglob('*') if f.is_file()}
                self.assertEqual(self.run_worker(client, retain_rejected_pages=True)['inferenceCalls'], 0)
                self.assertEqual(len(calls), 1)
                self.assertEqual(load(objective / 'findings.json'), [])
                self.assertEqual(worker.coverage(objective, manifest)['counts']['rejectedPages'], 1)
                for file, original in frozen.items():
                    self.assertEqual(file.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
