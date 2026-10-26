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
from test_objective_review import Client, QUEUE, DISPATCH


class ObjectiveRtfTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'id':'synthetic','version':'v1','kind':'life-timeline','ownerAliases':['Synthetic owner'],
                       'instructions':'','pageChars':6000,'overlap':300,
                       'selection':{'gmailMessageIds':['message01'],'outlookSha256':[]}}
        self.objective,self.manifest = None,None

    def mail(self, raw, plain=None):
        message=EmailMessage();message['From']='Synthetic owner <owner@example.invalid>'
        message['To']='Synthetic friend <friend@example.invalid>';message['Date']='Fri, 1 Aug 2014 10:00:00 +0000'
        message['Message-ID']='<synthetic-rtf@example.invalid>';message['Subject']='Synthetic RTF'
        if plain:message.set_content(plain)
        message.add_attachment(raw,maintype='application',subtype='rtf',filename='rtf-body.rtf')
        data=message.as_bytes();digest=hashlib.sha256(data).hexdigest();(self.root/'raw').mkdir()
        (self.root/'raw/source.eml').write_bytes(data)
        save(self.root/'raw-receipts/message01.json',{'messageId':'message01','threadId':'thread001','sha256':digest,'bytes':len(data),'path':'raw/source.eml','labelIds':['SENT']})
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
        attempts_before={p.relative_to(self.objective):p.read_bytes() for p in (self.objective/'review-attempts').glob('*/*/*.json')}
        result=self.run_worker(client)
        self.assertEqual(result['newlyReviewedPages'],1)
        self.assertEqual(len(client.calls),2)
        self.assertTrue(result['coverage']['allTargetTextCovered'])
        self.assertEqual(result['coverage']['counts']['reviewedPages'],2)
        self.assertEqual(old_file.read_bytes(),old_bytes)
        for p,data in attempts_before.items():self.assertEqual((self.objective/p).read_bytes(),data)
        plan=load(next((self.objective/'sources').glob('*.json')))
        self.assertIn(old_file.stem,plan['pageIds']);self.assertEqual(len(plan['pageIds']),2)
        new_file=next(p for p in (self.objective/'page-reviews').glob('*.json') if p!=old_file)
        new=load(new_file);self.assertIn('Un vrai corps auparavant opaque.',new['sourceRecord']['body'])
        self.assertEqual(new['sourceRecord']['nativeRef']['representation']['extraction']['profile'],PROFILE)
        self.assertEqual(plan['source']['rtfReaderProfile'],PROFILE)
        with patch('objective_review.materialize',side_effect=AssertionError('Current reader must fast-skip unchanged complete plan')):
            self.assertEqual(self.run_worker(client)['newlyReviewedPages'],0)
        self.assertEqual(len(client.calls),2)
        self.assertEqual((self.root/'raw/source.eml').read_bytes(),original)

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
        self.assertEqual(plan['source']['rtfReaderProfile'],PROFILE)

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
