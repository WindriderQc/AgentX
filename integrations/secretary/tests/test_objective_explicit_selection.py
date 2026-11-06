"""Complete declarations cannot be silently discarded or summarized as omitted facts."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import objective_explicit_selection as explicit
import objective_grounding as grounding
import objective_review as worker
from evidence_store import load, save
from objective_schema import normalize_representation, validate
from review_receipts import hashed
import test_objective_omission_policy as fixtures
import test_objective_dispositions as disposition_fixtures
import test_objective_source_language as worker_fixtures

SENT = {'ownerAliases': ['Personne Exemple'], 'direction': 'sent', 'offset': 0}


def wire_v10(value):
    """Fake model wire shape; never add a missing fact or repair an omission."""
    value = copy.deepcopy(value)
    value.pop('summaryCitationIds')
    return value


def positive(body, ids=('q1',), context=SENT):
    return wire_v10(fixtures.positive(body, ids, context=context))


def project(value, body, context=SENT):
    context = {'end': len(body), 'totalChars': len(body), **context}
    result, changes = normalize_representation(value, body, grounding.CONTRACT, context)
    validate(result, body)
    return result, changes


class ExplicitSelectionTests(unittest.TestCase):
    def test_complete_undated_activity_and_completed_move_have_no_blanket_omission_option(self):
        for body in ("J'ai pratiqué le snorkeling pendant ce séjour.",
                     'Mon déménagement étant terminé, je vais avoir davantage de temps.',
                     'Nous avons terminé notre formation.', 'I am on a hiking trip.'):
            with self.subTest(body=body):
                declarations = explicit.declarations(grounding.catalog(body), SENT)
                self.assertTrue(declarations[0]['ownerReadingContext'])
                self.assertEqual(explicit.catalog(grounding.catalog(body), SENT), [])
                schema = grounding.schema_for(body, source_context=SENT)
                self.assertEqual(len(schema['anyOf']), 1)
                self.assertEqual(schema['anyOf'][0]['properties']['omittedCues']['maxItems'], 0)
                result, changes = project(positive(body), body)
                self.assertIsNone(result['moments'][0]['startDate'])
                self.assertIsNone(result['moments'][0]['endDate'])
                self.assertFalse(result['moments'][0]['ongoing'])
                self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q1'])

    def test_old_insufficient_or_ambiguous_reason_cannot_replace_a_complete_declaration(self):
        body = 'Mon déménagement est terminé.'
        for code in ('insufficient-event-context', 'ambiguous-actor'):
            raw = wire_v10(fixtures.negative(body, cue_codes={'q1': code}, context=SENT))
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, 'complete personal declaration'):
                project(raw, body)

    def test_a_complete_declaration_cannot_be_silently_dropped_from_an_otherwise_positive_page(self):
        body = "J'ai pratiqué le snorkeling pendant ce séjour.\nJe débute la boxe."
        raw = positive(body, ('q2',));before = copy.deepcopy(raw)
        with self.assertRaisesRegex(ValueError, 'potentially useful source cue'):project(raw, body)
        self.assertEqual(raw, before)

    def test_unknown_and_continuation_speakers_keep_uncertain_omission_paths(self):
        body = 'Mon voyage est terminé.'
        for context in ({'ownerAliases': ['Personne Exemple'], 'offset': 0},
                        {**SENT, 'offset': 200}):
            with self.subTest(context=context):
                rows = explicit.catalog(grounding.catalog(body), context)
                self.assertTrue(any(r['reasonCode'] == 'ambiguous-actor' for r in rows))
                self.assertFalse(explicit.declarations(grounding.catalog(body), context)[0]['ownerReadingContext'])

    def test_a_quoted_owner_header_supports_the_completed_declaration_but_a_later_header_does_not(self):
        body = 'From: Personne Exemple\nMon déménagement est terminé.'
        ctx = {'ownerAliases': ['Personne Exemple'], 'direction': 'received', 'offset': 0}
        cue = explicit.declarations(grounding.catalog(body), ctx)[0]
        self.assertTrue(cue['ownerReadingContext']);self.assertEqual(cue['contextCitationIds'], ['q1','q2'])
        self.assertEqual(explicit.catalog(grounding.catalog(body), ctx), [])
        later = 'Mon déménagement est terminé.\nFrom: Personne Exemple'
        self.assertFalse(explicit.declarations(grounding.catalog(later), ctx)[0]['ownerReadingContext'])

    def test_foreign_and_unknown_quotes_do_not_inherit_sent_container_identity(self):
        for header in ('From: Auteur Autre', '--- Original Message ---', 'De : '):
            body = header+'\nMon voyage est terminé.'
            with self.subTest(header=header):
                self.assertFalse(explicit.declarations(grounding.catalog(body), SENT)[0]['ownerReadingContext'])
                self.assertTrue(explicit.catalog(grounding.catalog(body), SENT))

    def test_questions_hypotheses_negation_and_advertisements_never_force_a_fact(self):
        for body in ('Mon déménagement est terminé ?', "Je n'ai pas fait ce voyage.",
                     'Je suis peut-être en voyage.', 'Notre brochure : je suis en voyage.',
                     'Si je suis en voyage, je répondrai plus tard.', 'Mon déménagement...'):
            with self.subTest(body=body):
                self.assertEqual(explicit.declarations(grounding.catalog(body), SENT), [])
                self.assertTrue(any(r['reasonCode'] == 'insufficient-event-context'
                                    for r in explicit.catalog(grounding.catalog(body), SENT)))

    def test_other_speaker_omission_still_retains_its_author_header(self):
        body = 'Je débute la boxe.\nFrom: Auteur Autre\nOn a fait des sauts.'
        rows = explicit.catalog(grounding.catalog(body), SENT)
        other = next(r for r in rows if r['reasonCode'] == 'other-person-context')
        raw = positive(body);raw['omittedCues'] = [{'citationId':'q3','reasonRef':other['id']}]
        result, changes = project(raw, body)
        self.assertEqual(changes[0]['omissionPolicy']['selectedReasons'][0]['contextCitationIds'], ['q2','q3'])
        self.assertIn('From: Auteur Autre', result['gaps'][0])

    def test_summary_belongs_to_retained_observations_and_cannot_reintroduce_an_omitted_cue(self):
        body = 'Je débute la boxe.\nNotre brochure décrit un voyage promotionnel.'
        omitted = next(r for r in explicit.catalog(grounding.catalog(body), SENT)
                       if r['scope']=='cue' and r['citationId']=='q2' and r['reasonCode']=='non-biographical-context')
        raw = positive(body);raw['omittedCues']=[{'citationId':'q2','reasonRef':omitted['id']}]
        result, changes = project(raw, body)
        self.assertIn('Je débute la boxe.', result['summary']);self.assertNotIn('brochure', result['summary'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'], ['q1'])
        raw['summaryCitationIds']=['q2']
        with self.assertRaisesRegex(ValueError, 'never a separate global'):project(raw, body)

    def test_summary_uses_at_most_three_retained_title_excerpts(self):
        body = '\n'.join(['Je débute la boxe.','Mon voyage est terminé.','Nous avons terminé notre formation.','Je pratique l’escalade.'])
        raw = positive(body, ('q1',))
        prototype = raw['moments'][0]
        raw['moments'] = []
        for key in ('q1','q2','q3','q4'):
            moment=copy.deepcopy(prototype);moment['observations']=[{'citationId':key,'qualificationIds':[]}];moment['titleCitationId']=key
            raw['moments'].append(moment)
        result, changes = project(raw, body)
        self.assertEqual(len(result['moments']),4)
        self.assertEqual(changes[0]['retainedSummary']['citationIds'],['q1','q2','q3'])
        self.assertNotIn('escalade',result['summary'])
        raw['moments'][0]['observations'][0]['includeInSummary']=True
        with self.assertRaisesRegex(ValueError,'never a separate observation annotation'):project(raw,body)

    def test_cited_administrative_abstention_needs_no_model_summary_choice(self):
        admin='Objet : copies PDF\nBonne soirée !'
        result,changes=project(wire_v10(fixtures.negative(admin,'administrative-context')),admin)
        self.assertEqual(result['classification'],'no-life-event');self.assertIn('Objet : copies PDF',result['summary'])
        self.assertEqual(changes[0]['retainedSummary']['citationIds'],[])

    def test_v9_omission_and_inconsistent_summary_are_frozen_and_v10_rejects_them(self):
        self.assertEqual(hashed(grounding.SCHEMA_V9),'bf3a7d89ac0328dfb232c65fc27d8eb26aceb261a46f4a85088a98bcadfc0e97')
        body='Mon déménagement est terminé.'
        old=fixtures.negative(body,cue_codes={'q1':'insufficient-event-context'},context=SENT);old['summaryCitationIds']=['q1']
        result,_=normalize_representation(old,body,grounding.OMISSION_CONTRACT)
        self.assertIn(body,result['summary'])
        with self.assertRaises(ValueError):project(old,body)


class ExplicitSelectionWorkerTests(unittest.TestCase):
    setUp=worker_fixtures.SourceLanguageWorkerTests.setUp
    mail=worker_fixtures.SourceLanguageWorkerTests.mail
    prepare=worker_fixtures.SourceLanguageWorkerTests.prepare
    run_worker=worker_fixtures.SourceLanguageWorkerTests.run_worker

    def test_native_declarations_and_retained_summary_replay_without_another_call(self):
        body='Mon déménagement est terminé.\nJe débute la boxe.';self.mail('message01',body)
        def output(prompt,reply):
            self.assertEqual(prompt['groundingContract'],grounding.CONTRACT)
            self.assertEqual(prompt['omissionReasonCatalog'],[])
            self.assertEqual([r['citationId'] for r in prompt['declarationCatalog']],['q1','q2'])
            reply['response']=json.dumps(positive(body,('q1','q2')));return reply
        client,calls=disposition_fixtures.DispositionTests.client(self,output)
        self.assertEqual(self.run_worker(client)['newlyReviewedPages'],1)
        self.assertEqual(self.run_worker(client)['inferenceCalls'],0);self.assertEqual(len(calls),1)
        objective,manifest=self.prepare();file=next((objective/'page-reviews').glob('*.json'));row=worker.read_receipt(file,manifest)
        self.assertEqual(row['resultProcessing']['changes'][0]['retainedSummary']['citationIds'],['q1'])
        row['resultProcessing']['changes'][0]['retainedSummary']['citationIds']=['q999'];save(file,row)
        with self.assertRaisesRegex(ValueError,'retained native result'):worker.read_receipt(file,manifest)

    def test_unjustified_declaration_omission_is_retained_as_rejection_without_retry(self):
        body='Mon déménagement est terminé.';self.mail('message01',body)
        def output(prompt,reply):
            reply['response']=json.dumps(wire_v10(fixtures.negative(body,cue_codes={'q1':'insufficient-event-context'})));return reply
        client,calls=disposition_fixtures.DispositionTests.client(self,output)
        self.assertEqual(self.run_worker(client,retain_rejected_pages=True)['newlyRejectedPages'],1)
        self.assertEqual(self.run_worker(client,retain_rejected_pages=True)['inferenceCalls'],0);self.assertEqual(len(calls),1)
        objective,_=self.prepare();self.assertEqual(load(objective/'findings.json'),[])


if __name__=='__main__':unittest.main()
