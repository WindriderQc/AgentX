"""An RTF body is additional evidence; an old header read cannot cover it."""
from email.message import EmailMessage
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evidence_store import load, save
import objective_review as worker
from objective_sources import materialize
from archive_rtf import PROFILE
from test_objective_review import Client, QUEUE, DISPATCH, moment
import test_objective_dispositions as disposition_fixtures
import test_objective_review as review_fixtures


class ObjectiveRtfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'id':'synthetic','version':'v1','kind':'life-timeline','ownerAliases':['Synthetic owner'],
                       'instructions':'','pageChars':6000,'overlap':300,
                       'selection':{'gmailMessageIds':['message01'],'outlookSha256':[]}}
        self.objective,self.manifest = None,None

    def mail(self, raw, plain=None, copies=1):
        message=EmailMessage();message['From']='Synthetic owner <owner@example.invalid>'
        message['To']='Synthetic friend <friend@example.invalid>';message['Date']='Fri, 1 Aug 2014 10:00:00 +0000'
        message['Message-ID']='<synthetic-rtf@example.invalid>';message['Subject']='Synthetic RTF'
        if plain:message.set_content(plain)
        message.add_attachment(raw,maintype='application',subtype='rtf',filename='rtf-body.rtf')
        data=message.as_bytes();digest=hashlib.sha256(data).hexdigest();(self.root/'raw').mkdir(exist_ok=True)
        (self.root/'raw/source.eml').write_bytes(data)
        save(self.root/'raw-receipts/message01.json',{'messageId':'message01','threadId':'thread001','sha256':digest,'bytes':len(data),'path':'raw/source.eml','labelIds':['SENT']})
        for index in range(2,copies+1):
            mid=f'message{index:02d}';copy=b'X-Synthetic-Copy: '+str(index).encode()+b'\n'+data
            copy_sha=hashlib.sha256(copy).hexdigest();relative=f'raw/{mid}.eml'
            (self.root/relative).write_bytes(copy)
            save(self.root/f'raw-receipts/{mid}.json',{'messageId':mid,'threadId':'thread001','sha256':copy_sha,
                 'bytes':len(copy),'path':relative,'labelIds':['SENT']})
            self.config['selection']['gmailMessageIds'].append(mid)
        self.objective,self.manifest=worker.prepare(self.root,self.config)
        return data

    def run_worker(self,client):
        return worker.run(self.root,self.objective,self.manifest,client,max_pages=20,queue_id=QUEUE,dispatch_id=DISPATCH,max_seconds=30)

    def test_old_complete_header_receipt_is_preserved_and_new_body_ids_are_reviewed_once(self):
        original=self.mail(br'{\rtf1\ansi Un vrai corps auparavant opaque.}')
        client=Client()
        with patch('archive_read.is_rtf',return_value=False):
            old=self.run_worker(client)
        self.assertEqual(len(client.calls),1)
        self.assertEqual(old['coverage']['counts']['reviewedPages'],1)
        self.assertFalse(old['coverage']['allTargetTextCovered'])
        self.assertIn('rtf-reader-upgrade-pending',[g['code'] for g in old['coverage']['sources'][0]['gaps']])
        old_file=next((self.objective/'page-reviews').glob('*.json'));old_bytes=old_file.read_bytes()
        old_source=load(next((self.objective/'sources').glob('*.json')))['source']
        old_indices={p:p.read_bytes() for p in (self.objective/'equivalence-index').glob('*.json')}
        self.assertEqual(len(old_indices),1)
        attempts_before={p.relative_to(self.objective):p.read_bytes() for p in (self.objective/'review-attempts').rglob('*') if p.is_file()}
        self.assertTrue(attempts_before)
        result=self.run_worker(client)
        self.assertEqual(result['newlyReviewedPages'],1)
        self.assertEqual(len(client.calls),2)
        self.assertTrue(result['coverage']['allTargetTextCovered'])
        self.assertEqual(result['coverage']['counts']['reviewedPages'],2)
        self.assertEqual(old_file.read_bytes(),old_bytes)
        for p,data in attempts_before.items():self.assertEqual((self.objective/p).read_bytes(),data)
        plan=load(next((self.objective/'sources').glob('*.json')))
        self.assertIn(old_file.stem,plan['pageIds']);self.assertEqual(len(plan['pageIds']),2)
        self.assertEqual(plan['source'],old_source)
        for p,data in old_indices.items():self.assertEqual(p.read_bytes(),data)
        header={**next(u for u in plan['representations'] if u['representation']=='message-headers'),
                'content':load(old_file)['sourceRecord']['body']}
        canonical=worker.equivalent.find(self.objective,plan['source'],header,worker.read_receipt,self.manifest)
        self.assertEqual(canonical['canonicalPageIds'],[old_file.stem])
        new_file=next(p for p in (self.objective/'page-reviews').glob('*.json') if p!=old_file)
        new=load(new_file);self.assertIn('Un vrai corps auparavant opaque.',new['sourceRecord']['body'])
        self.assertEqual(new['sourceRecord']['nativeRef']['representation']['extraction']['profile'],PROFILE)
        self.assertEqual(plan['rtfReaderProfile'],PROFILE)
        with patch('objective_review.materialize',side_effect=AssertionError('Current reader must fast-skip unchanged complete plan')):
            self.assertEqual(self.run_worker(client)['newlyReviewedPages'],0)
        self.assertEqual(len(client.calls),2)
        self.assertEqual((self.root/'raw/source.eml').read_bytes(),original)

    def test_header_identity_survives_multiple_partial_body_rematerializations(self):
        self.mail(b'{\\rtf1\\ansi '+b'A'*14000+b'}')
        client=Client()
        with patch('archive_read.is_rtf',return_value=False):
            self.run_worker(client)
        old_file=next((self.objective/'page-reviews').glob('*.json'));old_bytes=old_file.read_bytes()
        prior_ids=set()
        for expected_calls in (2,3,4):
            result=worker.run(self.root,self.objective,self.manifest,client,max_pages=1,
                              queue_id=QUEUE,dispatch_id=DISPATCH,max_seconds=30)
            plan=load(next((self.objective/'sources').glob('*.json')))
            self.assertIn(old_file.stem,plan['pageIds'])
            self.assertEqual(len(plan['pageIds']),4)
            self.assertTrue(prior_ids <= set(plan['pageIds']))
            prior_ids=set(plan['pageIds'])
            self.assertEqual(len(client.calls),expected_calls)
            self.assertEqual(old_file.read_bytes(),old_bytes)
        self.assertTrue(result['coverage']['allTargetTextCovered'])

    def test_legacy_rejected_header_without_index_migrates_without_source_rewrite(self):
        self.mail(br'{\rtf1\ansi A readable body.}')
        def invalid_header(prompt, reply):
            if prompt['representation']['representation']=='message-headers':
                value=json.loads(reply['response'])
                value.update(classification='life-events',moments=[moment('Quote absent from this passage.')])
                reply['response']=json.dumps(value)
            return reply
        client,calls=disposition_fixtures.DispositionTests.client(self,invalid_header)
        with patch('archive_read.is_rtf',return_value=False), \
             patch('objective_review.rejected_copies.register'):
            first=worker.run(self.root,self.objective,self.manifest,client,max_pages=1,
                queue_id=QUEUE,dispatch_id=DISPATCH,retain_rejected_pages=True)
        self.assertEqual(first['newlyRejectedPages'],1)
        old_file=next((self.objective/'page-dispositions').glob('*.json'));old_bytes=old_file.read_bytes()
        old_source=load(old_file)['source']
        self.assertFalse(list((self.objective/'rejected-copy-index').glob('*.json')))
        result=worker.run(self.root,self.objective,self.manifest,client,max_pages=20,
            queue_id=QUEUE,dispatch_id=DISPATCH,retain_rejected_pages=True)
        self.assertEqual(result['phase'],'partial')
        self.assertEqual(result['coverage']['counts']['rejectedPages'],1)
        self.assertEqual(result['coverage']['counts']['reviewedPages'],1)
        plan=load(next((self.objective/'sources').glob('*.json')))
        self.assertEqual(plan['source'],old_source)
        self.assertIn(old_file.stem,plan['pageIds'])
        self.assertEqual(old_file.read_bytes(),old_bytes)
        self.assertEqual(len(calls),2)
        worker.run(self.root,self.objective,self.manifest,client,max_pages=20,
            queue_id=QUEUE,dispatch_id=DISPATCH,retain_rejected_pages=True)
        self.assertEqual(len(calls),2)

    def test_known_failed_body_stays_uncovered_but_does_not_reparse_forever(self):
        self.mail(br'{\rtf1\ansicpg99999 Corps illisible.}')
        client=Client();first=self.run_worker(client)
        self.assertEqual(first['coverage']['counts']['reviewedPages'],1)
        self.assertFalse(first['coverage']['allTargetTextReviewed'])
        self.assertFalse(first['coverage']['allTargetTextCovered'])
        row=first['coverage']['sources'][0]
        self.assertIn('rtf-text-unreadable',[g['code'] for g in row['gaps']])
        self.assertEqual(row['pendingPages'],0)
        with patch('objective_review.materialize',side_effect=AssertionError('Known current-profile gap is already materialized')):
            second=self.run_worker(client)
        self.assertFalse(second['coverage']['allTargetTextCovered']);self.assertEqual(len(client.calls),1)
        plan=load(next((self.objective/'sources').glob('*.json')))
        self.assertEqual(plan['rtfReaderProfile'],PROFILE)

    def test_current_failed_rtf_and_terminal_rejected_header_do_not_reparse(self):
        review_fixtures.ObjectiveTests.mail(self,'message02','An unrelated second message.')
        self.config['selection']['gmailMessageIds'].append('message02')
        self.mail(br'{\rtf1\ansicpg99999 Unreadable.}')
        def invalid_header(prompt,reply):
            if prompt['source']['id']=='message01':
                value=json.loads(reply['response'])
                value.update(classification='life-events',moments=[moment('Absent quote.')])
                reply['response']=json.dumps(value)
            return reply
        client,calls=disposition_fixtures.DispositionTests.client(self,invalid_header)
        first=worker.run(self.root,self.objective,self.manifest,client,max_pages=1,
             queue_id=QUEUE,dispatch_id=DISPATCH,retain_rejected_pages=True)
        self.assertEqual(first['newlyRejectedPages'],1)
        rejected=next((self.objective/'page-dispositions').glob('*.json'));before=rejected.read_bytes()
        def no_failed_reparse(root,source):
            self.assertNotEqual(source['id'],'message01','Current failed RTF must not be reparsed')
            return materialize(root,source)
        with patch('objective_review.materialize',side_effect=no_failed_reparse):
            second=worker.run(self.root,self.objective,self.manifest,client,max_pages=20,
                 queue_id=QUEUE,dispatch_id=DISPATCH,retain_rejected_pages=True)
        self.assertEqual(second['newlyReviewedPages'],1)
        self.assertEqual(second['coverage']['counts']['pendingPagesKnown'],0)
        self.assertFalse(second['coverage']['allTargetTextCovered'])
        self.assertEqual(len(calls),2);self.assertEqual(rejected.read_bytes(),before)
        with patch('objective_review.materialize',side_effect=AssertionError('No source requires rematerialization')):
            worker.run(self.root,self.objective,self.manifest,client,max_pages=20,
                 queue_id=QUEUE,dispatch_id=DISPATCH,retain_rejected_pages=True)
        self.assertEqual(len(calls),2)

    def test_old_accepted_header_alias_is_not_rewritten_during_rtf_upgrade(self):
        self.mail(br'{\rtf1\ansi A shared RTF body.}',copies=2)
        client=Client()
        with patch('archive_read.is_rtf',return_value=False),patch('objective_equivalence.now',return_value='2020-01-01T00:00:00Z'):
            self.run_worker(client)
        self.assertEqual(len(client.calls),1)
        self.assertEqual(len(list((self.objective/'equivalences').glob('*.json'))),1)
        before={p:p.read_bytes() for directory in ['equivalences','equivalence-index','page-reviews','review-attempts']
                for p in (self.objective/directory).rglob('*') if p.is_file()}
        with patch('objective_equivalence.now',return_value='2021-01-01T00:00:00Z'):
            result=self.run_worker(client)
        self.assertTrue(result['coverage']['allTargetTextCovered'])
        self.assertEqual(len(client.calls),2)
        for p,data in before.items():self.assertEqual(p.read_bytes(),data,str(p))

    def test_plain_text_does_not_hide_a_known_unreadable_rtf_variant(self):
        self.mail(b'{\\rtf1 caf\xe9}',plain='Readable alternative without the extra detail.')
        first=self.run_worker(Client())
        self.assertEqual(first['coverage']['counts']['reviewedPages'],1)
        self.assertFalse(first['coverage']['allTargetTextCovered'])
        self.assertIn('rtf-text-unreadable',[g['code'] for g in first['coverage']['sources'][0]['gaps']])

    def test_new_text_keeps_extraction_identity_separate_from_plain_alternative(self):
        self.mail(br'{\rtf1\ansi Same literal text.}',plain='Same literal text.')
        source=self.manifest['sources'][0];current,units,gaps=materialize(self.root,source)
        self.assertEqual(len(units),2)
        self.assertNotEqual(units[0],units[1])
        self.assertNotIn('extraction',units[0]);self.assertEqual(units[1]['extraction']['profile'],PROFILE)
        self.assertEqual(current['sha256'],source['sha256'])


if __name__=='__main__':unittest.main()
