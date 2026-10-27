"""Synthetic inert RTF text and native original-reader contracts."""
from email.message import EmailMessage
from email import policy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from archive_rtf import read_part, is_rtf, PROFILE, MAX_PART_BYTES, RtfError, _convert
from archive_read import representations, read_original
from evidence_store import save


def part(data, mime='application/rtf', cte='base64', filename=None):
    value = EmailMessage()
    value.set_content(data, maintype=mime.split('/')[0], subtype=mime.split('/')[1], cte=cte)
    if filename:
        value.add_header('Content-Disposition', 'attachment', filename=filename)
    return value


class RtfTextTests(unittest.TestCase):
    def test_vendored_distribution_files_are_unchanged(self):
        folder = ROOT/'_vendor/striprtf'
        upstream = json.loads((folder/'UPSTREAM.json').read_text())
        self.assertEqual(upstream['version'], '0.0.34')
        self.assertEqual(upstream['license'], 'BSD-3-Clause')
        self.assertEqual(upstream['distributionSha256'], '32113e70a99d00e7f0f64d4850c3ad11126501e200aeb29c5270526a6eba52e2')
        for name, digest in upstream['files'].items():
            self.assertEqual(hashlib.sha256((folder/name).read_bytes()).hexdigest(), digest)

    def test_transfer_encodings_variants_accents_and_provenance(self):
        raw = br"{\rtf1\ansi\ansicpg1252 Bonjour, caf\'e9.\line Deuxi\'e8me ligne.}"
        for mime in ('application/rtf','text/rtf','application/x-rtf','application/octet-stream'):
            for cte in ('base64','quoted-printable','8bit'):
                with self.subTest(mime=mime, cte=cte):
                    p = part(raw, mime, cte, 'body.rtf')
                    result = read_part(p)
                    self.assertTrue(result['readable'], result)
                    self.assertEqual(result['content'], 'Bonjour, café.\nDeuxième ligne.')
                    self.assertEqual(result['extraction']['decodedPartSha256'], hashlib.sha256(raw).hexdigest())
                    self.assertEqual(result['extraction']['profile'], PROFILE)
                    self.assertEqual(result['extraction']['filename'], 'body.rtf')
                    bodies, docs = representations(p)
                    self.assertEqual(bodies[0]['content'], result['content'])
                    self.assertEqual(docs[0]['mimeType'], mime)
        self.assertFalse(is_rtf('text/richtext'))
        self.assertFalse(is_rtf('application/octet-stream', 'body.pdf'))

    def test_unicode_fallback_surrogates_escaped_controls_and_font_codepage(self):
        raw = br"{\rtf1\ansi caf\u233? \u-10179?\u-8704? \{vrai\} \\fin\tab ok}"
        value = read_part(part(raw))
        self.assertEqual(value['content'], 'café 😀 {vrai} \\fin\tok')
        marker = br'{\rtf1{\*\formatConverter converted from text} Visible.}'
        self.assertEqual(read_part(part(marker))['content'], ' Visible.')
        cyrillic = br"{\rtf1\ansi{\fonttbl{\f0\fcharset204 Arial;}}\f0 \'cf\'f0\'e8\'e2\'e5\'f2}"
        self.assertEqual(read_part(part(cyrillic))['content'], 'Привет')

    def test_unsupported_or_malformed_never_returns_partial_text(self):
        cases = [(b'not RTF','rtf-signature-invalid'),
            (br'{\rtf1 missing','rtf-structure-invalid'),
            (br'{\rtf1 ok} hidden','rtf-trailing-content'),
            (br'{\rtf1\ansicpg99999 text}','rtf-codepage-unsupported'),
            (br'{\rtf1\mac text}','rtf-default-codepage-unsupported'),
            (br'{\rtf1\bin3 abc}','rtf-binary-unsupported'),
            (br'{\rtf1\BIN3 abc}','rtf-control-case-unsupported'),
            (br'{\rtf1\formatConverter text}','rtf-control-case-unsupported'),
            (br'{\rtf1\u0?}','rtf-decoded-control-invalid'),
            (br'{\rtf1\u-10179?}','rtf-text-decode-failed'),
            (br'{\rtf1\u999999?}','rtf-unicode-control-invalid'),
            (br'{\rtf1\uc-1 text}','rtf-unicode-control-invalid'),
            (br"{\rtf1 \'zz}",'rtf-escape-invalid'),
            (br'{\rtf1{\field{\*\fldinst HYPERLINK "https://example.invalid"}{\fldrslt text}}}','rtf-text-destination-unsupported'),
            (b'{\\rtf1 caf\xe9}','rtf-raw-8bit-unsupported'),
            (b'{\\rtf1 '+b'{'*65+b'text'+b'}'*66,'rtf-structure-limit')]
        for raw, reason in cases:
            with self.subTest(reason=reason):
                result = read_part(part(raw))
                self.assertFalse(result['readable'], result)
                self.assertEqual(result['content'], '')
                self.assertEqual(result['extraction']['reason'], reason)
                self.assertEqual(result['extractionGaps'][0]['code'], 'rtf-text-unreadable')

    def test_images_objects_are_not_read_or_executed_and_keep_gaps(self):
        result = read_part(part(br'{\rtf1 Visible {\pict\pngblip 001122}{\object{\*\objdata 445566}} fin}'))
        self.assertTrue(result['readable'])
        self.assertEqual(result['content'], 'Visible  fin')
        self.assertNotIn('001122', result['content'])
        self.assertEqual(result['extractionGaps'][0]['code'], 'rtf-nontext-content-not-qualified')
        self.assertIn('object', result['extraction']['omittedKinds'])

    def test_payload_output_and_cpu_limits_remain_explicit(self):
        with patch('archive_rtf.subprocess.run', side_effect=AssertionError('Oversize must not start parser')):
            self.assertEqual(read_part(part(b'x'*(MAX_PART_BYTES+1)))['extraction']['reason'], 'rtf-part-size-limit')
        with patch('archive_rtf.subprocess.run', side_effect=subprocess.TimeoutExpired('parser', 3)):
            self.assertEqual(read_part(part(br'{\rtf1 text}'))['extraction']['reason'], 'rtf-parser-time-limit')
        with patch('archive_rtf.MAX_TEXT_BYTES', 2):
            with self.assertRaisesRegex(RtfError, 'rtf-text-size-limit'):
                _convert(br'{\rtf1 texte}')
        bad = part(br'{\rtf1 text}')
        bad.set_payload('???')
        self.assertEqual(read_part(bad)['extraction']['reason'], 'rtf-mime-transfer-invalid')

    def test_native_original_api_falls_back_to_rtf_without_claiming_visual_or_full_message(self):
        message = EmailMessage(); message['Subject']='Synthetic RTF message'
        message.add_attachment(br'{\rtf1\ansi Texte du vrai corps.}', maintype='application', subtype='rtf', filename='rtf-body.rtf')
        data=message.as_bytes(policy=policy.SMTP); digest=hashlib.sha256(data).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'raw').mkdir(); (root/'raw/source.eml').write_bytes(data)
            save(root/'raw-receipts/message01.json',{'messageId':'message01','threadId':'thread001','sha256':digest,'bytes':len(data),'path':'raw/source.eml'})
            result=read_original(root,'message01',digest)
            self.assertEqual(result['body'],'Texte du vrai corps.')
            self.assertEqual(result['bodyCompleteScope'],'selected-mime-rtf-text-part')
            self.assertTrue(result['attachmentContentIncluded'])
            self.assertIn('rtf_text_only_not_visual_review',result['readingWarnings'])
            self.assertEqual(result['bodyRepresentations'][0]['extraction']['version'],'0.0.34')
            again=read_original(root,'message01',digest,part_index=result['selectedPartIndex'])
            self.assertEqual(result['body'],again['body'])
            self.assertEqual((root/'raw/source.eml').read_bytes(),data)


if __name__ == '__main__':
    unittest.main()
