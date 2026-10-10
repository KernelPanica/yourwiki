"""PDF base files and their independently stored annotation artifacts."""
from django.db import models


class PdfAnnotationLayer(models.Model):
    document = models.OneToOneField('wiki.Document', on_delete=models.CASCADE, related_name='pdf_layer')
    base_digest = models.CharField(max_length=255)
    reference = models.TextField()
    content_digest = models.CharField(max_length=64)
    revision = models.PositiveIntegerField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = 'wiki'
