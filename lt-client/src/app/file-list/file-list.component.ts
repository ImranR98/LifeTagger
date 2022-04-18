import { Component, OnInit } from '@angular/core';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'app-file-list',
  templateUrl: './file-list.component.html',
  styleUrls: ['./file-list.component.scss']
})
export class FileListComponent implements OnInit {

  loading = false
  files: { file: string, existingTags: string[] }[] = []

  constructor(private apiService: ApiService) { }

  ngOnInit(): void {
    this.loading = true
    this.apiService.getFiles().then(result => {
      this.files = result.files
    }).catch(err => {
      console.error(err)
    }).finally(() => {
      this.loading = false
    })
  }

  tagString(tags: string[]) {
    return tags.join(', ')
  }

}
